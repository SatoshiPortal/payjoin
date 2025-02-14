#!/bin/sh

SCRIPT_DIR=$(dirname "$0")

. "${SCRIPT_DIR}/resume.sh"
. "${SCRIPT_DIR}/locking.sh"
. "${SCRIPT_DIR}/trace.sh"

OUTPUT_FILE="/tmp/payjoin_output.txt"

# turn on rust logging
export RUST_LOG=debug
export RUST_BACKTRACE=1

parse_receive_output() {
  local output_file="$1"

  # Known errors to parse for:
  #
  # - "Error: base58 error" (invalid address)
  # - "Error: invalid digit found in string" (invalid amount)
  if grep -q "Error: base58 error" "${output_file}"; then
    echo "{\"error\":\"Invalid address format\"}"
    return 0
  fi
  
  if grep -q "Error: invalid digit found in string" "${output_file}"; then
    echo "{\"error\":\"Invalid amount format\"}"
    return 0
  fi
 
  local match="Request Payjoin by sharing this Payjoin Uri:"
  
  match_line=$(grep -n "${match}" "${output_file}" | cut -d: -f1)
  if [ -n "${match_line}" ]; then
    next_line=$((match_line + 1))
    bitcoin_uri=$(sed -n "${next_line}p" "${output_file}")

    case "$bitcoin_uri" in
      bitcoin:*)
        echo "{\"uri\":\"$bitcoin_uri\"}"
        return 0
        ;;
    esac
  fi

  # process has died or is just a zombie
  if ! kill -0 ${PAYJOIN_PID} 2>/dev/null || ps -p ${PAYJOIN_PID} -o stat= | grep -q '^Z'; then
    trace "[parse_receive_output] Process died with unknown error"
    output=$(cat "${output_file}" | tr -d '\000-\037' | sed 's/"/\\"/g')
    echo "{\"error\":\"Unknown error\", \"output\":\"${output}\"}"
    return 0
  fi

  return 1
}

parse_send_output() {
  local output_file="$1"

  # Known errors to parse for:
  #
  # - "error: Invalid value '' for '--fee-rate <FEE_SAT_PER_VB>'""
  # - "Error: Failed to create URI from BIP21: invalid BIP21 URI"
  if grep -E -q "error: Invalid value .* for '--fee-rate <FEE_SAT_PER_VB>'" "${output_file}"; then
    echo "{\"error\":\"Invalid fee rate format\"}"
    return 0
  fi

  if grep -q "Error: Failed to create URI from BIP21: invalid BIP21 URI" "${output_file}"; then
    echo "{\"error\":\"Invalid BIP21 URI\"}"
    return 0
  fi

  local match="Payjoin sent. TXID:"
  
  # Look for match line and extract TXID
  if txid=$(grep "${match}" "${output_file}" | sed "s/${match} //"); then
    if [ -n "${txid}" ]; then
      echo "{\"status\":\"completed\",\"txid\":\"${txid}\"}"
      return 0
    fi
  fi

  # process has died or is just a zombie
  if ! kill -0 ${PAYJOIN_PID} 2>/dev/null || ps -p ${PAYJOIN_PID} -o stat= | grep -q '^Z'; then
    trace "[parse_send_output] Process died with unknown error"
    output=$(cat "${output_file}" | tr -d '\000-\037' | sed 's/"/\\"/g')
    echo "{\"error\":\"Unknown error\", \"output\":\"${output}\"}"
    return 0
  fi

  return 1
}

monitor_output() {
  local cmd="$1"
  local output_file="$2"
  local timeout=30
  local start_time=$(date +%s)
  
  while true; do
    # Check timeout
    local current_time=$(date +%s)
    local elapsed=$((current_time - start_time))
    if [ ${elapsed} -ge ${timeout} ]; then
      trace "[monitor_output] Timeout after ${timeout} seconds"
      output=$(cat "${output_file}" | tr -d '\000-\037' | sed 's/"/\\"/g')
      echo "{\"error\":\"Operation timed out after ${timeout} seconds\", \"output\":\"${output}\"}"
      kill ${PAYJOIN_PID} 2>/dev/null || true
      return 0
    fi

    if [ "$cmd" = "receive" ]; then
        if response=$(parse_receive_output "${output_file}"); then
            echo "${response}"
            return 0
        fi
    else
        if response=$(parse_send_output "${output_file}"); then
            echo "${response}"
            return 0
        fi
    fi

    # Check if process is still running
    if ! kill -0 ${PAYJOIN_PID} 2>/dev/null || ps -p ${PAYJOIN_PID} -o stat= | grep -q '^Z'; then
        trace "[monitor_output] payjoin-cli process died"
        return 1
    fi
    
    sleep 0.1
  done
}

# Function to execute a payjoin-cli command
execute_payjoin() {
  trace "[execute_payjoin] command: '$*'"

  # Kill any existing resume process
  kill_resume

  trap 'cleanup' EXIT

  # Main execution
  if ! acquire_lock; then
    trace "[execute_payjoin] Another payjoin process is running"
    echo "{\"error\":\"Problem acquiring lock. Please try again\"}"
    return 1
  fi

  # Clear and create output file - @todo should this go to a log directory?
  cp "${OUTPUT_FILE}" "${OUTPUT_FILE}.$(date +%Y%m%d_%H%M%S)" 2>/dev/null || true
  : > "${OUTPUT_FILE}"

  # Run payjoin command and capture output
  (payjoin-cli "$@" > "${OUTPUT_FILE}" 2>&1) &
  PAYJOIN_PID=$!
  export PAYJOIN_PID

  trace "[execute_payjoin] Started payjoin-cli with PID=${PAYJOIN_PID}"

  # Monitor output and get response
  if ! response=$(monitor_output "$1" "${OUTPUT_FILE}"); then
      trace "[execute_payjoin] Failed to get valid response"
      echo "{\"error\":\"Failed to get valid response\"}"
      return 1
  fi

  trace "[execute_payjoin] responding=${response}"
  echo "${response}"
  return 0
}