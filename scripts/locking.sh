#!/bin/sh

SCRIPT_DIR=$(dirname "$0")

. "${SCRIPT_DIR}/resume.sh"
. "${SCRIPT_DIR}/trace.sh"

LOCK_FILE="/tmp/payjoin.lock"

check_lock() {
  if [ ! -f "${LOCK_FILE}" ]; then
    trace "[check_lock] No lock file exists"
    return 1
  fi

  # Try to acquire a shared lock without blocking
  if flock -n -s 9 2>/dev/null; then
    # If we got the shared lock, no exclusive lock exists
    flock -u 9 2>/dev/null
    trace "[check_lock] Lock file exists but is not locked"
    return 1
  fi

  trace "[check_lock] Lock is active"
  return 0
}

# acquire lock
acquire_lock() {
  touch "${LOCK_FILE}"

  exec 9>"${LOCK_FILE}" || {
    trace "[acquire_lock] Failed to open lock file descriptor"
    return 1
  }

  trace "[acquire_lock] Waiting for lock..."
  if ! timeout 10s flock 9; then
    exec 9>&-
    trace "[acquire_lock] Failed to acquire lock"
    return 1
  fi

  trace "[acquire_lock] Lock acquired"
  return 0
}

# release lock
release_lock() {
  # Check if descriptor is valid
  if [ -e /dev/fd/9 ]; then
      flock -u 9
      exec 9>&-
      trace "[release_lock] Lock released"
  fi
}

cleanup() {
  trace "[cleanup] Cleaning up ${PAYJOIN_PID}..."

  # Kill running processes
  if [ -n "${PAYJOIN_PID}" ]; then
    kill ${PAYJOIN_PID} 2>/dev/null || true
    trace "[cleanup] Waiting for payjoin-cli to exit..."

    # Give it a moment to terminate gracefully
    sleep 0.5
    
    # Check if still running
    if kill -0 ${PAYJOIN_PID} 2>/dev/null; then
      trace "[cleanup] Process still running, forcing termination..."
      kill -9 ${PAYJOIN_PID} 2>/dev/null || true
    fi
    
    trace "[cleanup] Waiting for process to exit..."
    wait ${PAYJOIN_PID} 2>/dev/null || true
    trace "[cleanup] Process exited"
  fi
  
  # Release resources
  trace "[cleanup] Releasing lock..."
  release_lock
  rm -f "${PIPE_FILE}"
  
  trace "[cleanup] Done"
  start_resume
  trace "[cleanup] resumed started"
}