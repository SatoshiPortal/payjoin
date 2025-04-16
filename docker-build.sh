#!/bin/bash

PAYJOIN_VERSION="v0.1.0-local"

SCRIPT_DIR=$(cd "$(dirname "$0")"; pwd)

docker build -t cyphernode/payjoin:$PAYJOIN_VERSION -f $SCRIPT_DIR/Dockerfile $SCRIPT_DIR/