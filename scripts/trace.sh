#!/bin/sh

TRACING=1
LOG_FILE="/data/payjoin-request.log"

trace() {
  touch "${LOG_FILE}"

  if [ -n "${TRACING}" ]; then
    local str="$(date -Is) $$ ${1}"
    echo "${str}" 1>&2
    echo "${str}" >> "${LOG_FILE}"
  fi
}

trace_rc() {
  touch ${LOG_FILE}

  if [ -n "${TRACING}" ]; then
    local str="$(date -Is) $$ Last return code: ${1}"
    echo "${str}" 1>&2
    echo "${str}" >> "${LOG_FILE}"
  fi
}