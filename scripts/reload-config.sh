#!/bin/sh

SERVICE_NAME="payjoin"

# Get container IDs for all replicas (filter by name pattern)
CONTAINER_IDS=$(docker ps -q --filter "name=${SERVICE_NAME}\.")

for CONTAINER_ID in $CONTAINER_IDS; do
  if [ -n "$CONTAINER_ID" ]; then
    # Execute curl inside the container to call the API on localhost
    docker exec $CONTAINER_ID curl -s -X POST -H "Content-Type: application/json" -d '{
      "jsonrpc": "2.0",
      "id": 1,
      "method": "reloadConfig"
    }' http://localhost:8000/jsonrpc | jq
  fi
done
