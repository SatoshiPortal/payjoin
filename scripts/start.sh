#!/bin/sh

SCRIPT_DIR=$(dirname "$0")

. "${SCRIPT_DIR}/resume.sh"
. "${SCRIPT_DIR}/locking.sh"

HTTP_PORT=8000
RESUME_INTERVAL=30

# We always run the payjoin-cli command from /data as that is where the config/db resides
cd /data

# periodically attempt to start the payjoin resume handler in case we have any requests outstanding
# The process automatically ends if no requests are outstanding so we will keep checking it
periodic_resume() {
  while true; do
    start_resume
    sleep ${RESUME_INTERVAL}
  done
}

periodic_resume &
PERIODIC_PID=$!

container_cleanup() {
  kill ${PERIODIC_PID}
  kill_resume
  pkill nc
}

trap container_cleanup TERM

nc -vlkp${HTTP_PORT} -e "${SCRIPT_DIR}/requesthandler.sh"
wait
