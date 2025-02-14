#!/bin/sh

SCRIPT_DIR=$(dirname "$0")

. "${SCRIPT_DIR}/command.sh"
. "${SCRIPT_DIR}/responsetoclient.sh"

main() {
  trace "Entering main()..."

  local step=0
  local cmd
  local http_method
  local line
  local content_length
  local response
  local returncode

  while read line; do
    line=$(echo "${line}" | tr -d '\r\n')
    trace "[main] line=${line}"

    if [ "${cmd}" = "" ]; then
      # First line!
      # Looking for something like:
      # GET /cmd/params HTTP/1.1
      # POST / HTTP/1.1
      cmd=$(echo "${line}" | cut -d '/' -f2 | cut -d ' ' -f1)
      trace "[main] cmd=${cmd}"
      http_method=$(echo "${line}" | cut -d ' ' -f1)
      trace "[main] http_method=${http_method}"
      if [ "${http_method}" = "GET" ]; then
        step=1
      fi
    fi
    if [ "${line}" = "" ]; then
      trace "[main] empty line"
      if [ ${step} -eq 1 ]; then
        trace "[main] body part finished, disconnecting"
        break
      else
        trace "[main] headers part finished, body incoming"
        step=1
      fi
    fi
    # line=content-length: 406
    case "${line}" in *[cC][oO][nN][tT][eE][nN][tT]-[lL][eE][nN][gG][tT][hH]*)
      content_length=$(echo "${line}" | cut -d ' ' -f2)
      trace "[main] content_length=${content_length}";
      ;;
    esac
    if [ ${step} -eq 1 ]; then
      trace "[main] step=${step}"
      if [ "${http_method}" = "POST" ] && [ "${content_length}" -gt "0" ]; then
#        read -rd '' -n ${content_length} line
        line=$(dd bs=1 count=${content_length} 2>/dev/null)
        line=$(echo "${line}" | jq -c)
        trace "[main] line=${line}"
      fi
      case "${cmd}" in
        helloworld)
          # GET http://192.168.111.152:8080/helloworld
          response='{"hello":"world"}'
          returncode=0
          # response_to_client "Hello, world!" 0
          # break
          ;;
        receive)
          amount=$(echo "${line}" | jq -r '.amount')
          address=$(echo "${line}" | jq -r '.address // ""')

          if [ "${address}" = "" ]; then
            response=$(execute_payjoin receive "$amount")
          else
            response=$(execute_payjoin receive "$amount" "--address" "$address")
          fi

          trace "[main] receive command response=${response}"
          returncode=$?
          ;;
        send)
          feerate=$(echo "${line}" | jq -r '.feerate // 2')
          uri=$(echo "${line}" | jq -r '.uri')

          response=$(execute_payjoin send "--fee-rate" $feerate "${uri}")
          returncode=$?
          ;;
        *)
          response='{"error": {"code": -32601, "message": "Method not found"}, "id": "1"}'
          returncode=1
          ;;
      esac
      trace "[main] response=${response}"
      response=$(echo "${response}" | jq -Mc)
      response_to_client "${response}" ${returncode}
      break
    fi
  done
  trace "[main] exiting"
  return ${returncode}
}

main
returncode=$?
trace "[request] exiting"
exit ${returncode}