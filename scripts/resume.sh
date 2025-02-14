#!/bin/sh

SCRIPT_DIR=$(dirname "$0")

. "${SCRIPT_DIR}/trace.sh"

kill_resume() {
    # Find all payjoin-cli resume processes
    pids=$(pgrep -f "payjoin-cli resume")
    if [ -n "${pids}" ]; then
        for pid in ${pids}; do
            trace "[kill_resume] Attempting to kill process: ${pid}"
            
            # Try gentle kill first
            kill "${pid}" 2>/dev/null || true
            
            # Wait for process to terminate
            for i in $(seq 1 5); do
                if ! kill -0 "${pid}" 2>/dev/null; then
                    trace "[kill_resume] Process terminated: ${pid}"
                    break
                fi
                sleep 0.1
            done
            
            # Force kill if still running
            if kill -0 "${pid}" 2>/dev/null; then
                trace "[kill_resume] Force killing process: ${pid}"
                kill -9 "${pid}" 2>/dev/null || true
            fi
            
            # Clean up any orphaned tail processes
            pkill -f "tail -F /tmp/payjoin-resume.log" 2>/dev/null || true
        done
    else
        trace "[kill_resume] No resume processes found"
    fi
}

start_resume() {
  if check_lock; then
    trace "[start_resume] Another payjoin process is active"
    return 1
  fi

  if pgrep -f "payjoin-cli resume" >/dev/null; then
      trace "[start_resume] payjoin-cli resume process already running"
      return 1
  fi

  trace "[start_resume] Starting payjoin-cli resume"
  
  # Start payjoin-cli in background with output redirection
  payjoin-cli resume >> /tmp/payjoin-resume.log 2>&1 &
  RESUME_PID=$!
  export RESUME_PID
  
  (tail -F /tmp/payjoin-resume.log | sed 's/^/[resume] /' >&2) 2>/dev/null &

  trace "[start_resume] Started with PID=${RESUME_PID}"
}