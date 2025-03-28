# Payjoin Cypherapp (MVP)

This payjoin cypherapp is a basic implementation that makes use of payjoin-cli from https://github.com/payjoin/rust-payjoin. The container will run a `payjoin-cli resume` process in the background as well as a simlpe HTTP server that will accept Payjoin requests and attempt to process them.

The API is simple and handles two request types: send and receive.

Due to the sled db that payjoin-cli uses only one process can run at a time (caused by locking on the db). To handle this when a request is received we kill the running `payjoin-ci resume` process and start a new process running the relevant command. The app also implements locking so only a single request can be processed at a time. To work around this limitation we can either run multiple instances of this app or handle queuing on the client side. Once the request is processed the `payjoin-cli resume` process is started again to listen and/or process any outstanding "sessions".

If the sled db has no outstanding sessions the `payjoin-cli resume` process will exit. We periodically (every 30 seconds) restart the process.


## API


### Receive

Create a Payjoin receive request with address provided:
```bash
curl -X POST http://localhost:8000/jsonrpc \
     -H "Content-Type: application/json" \
     -d '{
          "jsonrpc": "2.0",
          "id": 1,
          "method": "receive",
          "params": {
            "address": "bcrt1q8a9v943thzgqqeg9zycrryae3cgpng6k59nqr4",
            "amount": 10000000,
            "callbackUrl": "https://example.com/callback"
          }
        }' | jq
```
_Note: when an address is provided in this way payjoin has no way to verify the address belongs to one of our wallets. This API should be locked down as much as possible_


Create a Payjoin receive request without providing an address:
```bash
curl -H 'Content-Type: application/json' \
 -d '{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "receive",
  "params": {
    "amount": 10000000
  }
}' http://localhost:8000/jsonrpc
```

#### Successful response:
```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "id": 42,
    "bip21": "bitcoin:bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq?amount=0.1&pjos=0&pj=HTTPS://PAYJO.IN/ZFV5JGYXKQ3NX%23RK1QVLSWLM5USRWPADY9GQC0UMKAPSXE8GSJCYG23RHJ3WUERW08RAUC+OH1QYPM59NK2LXXS4890SUAXXYT25Z2VAPHP0X7YEYCJXGWAG6UG9ZU6NQ+EX1DRE27EC",
    "amount": "10000000",
    "address": "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq",
    "txid": null,
    "status": "pending",
    "expiryTs": "2025-03-25T22:30:45.123Z",
    "confirmedTs": null,
    "cancelledTs": null,
    "callbackUrl": "https://example.com/callback/42",
    "calledBackTs": null,
    "createdTs": "2025-03-25T21:30:45.123Z",
    "updatedTs": "2025-03-25T21:30:45.123Z"
  }
}
```

#### Error responses:
```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "error": {
    "code": -32602,
    "message": "Invalid amount format",
    "data": null
  }
}
```

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "error": {
    "code": -32602,
    "message": "Invalid address format",
    "data": null
  }
}
```

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "error": {
    "code": -32603,
    "message": "Unknown error",
    "data": "..."
  }
}
```


### Send

Send a Payjoin transaction:
```bash
curl -H 'Content-Type: application/json' \
 -d "{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "send",
  "params": {
    "bip21": "bitcoin:bcrt1q5f6jz3hn9nv3wx3sjgea5p37yldc5p3xrphau4?amount=0.001&pjos=0&pj=HTTPS://PAYJO.IN/DY0LZN5AKK8FJ%23RK1QTVMMHJ8PPST9HCYZENL87YHCCNVNU2S5PF789HMXHGHLR4FUFN8S+OH1QYPM59NK2LXXS4890SUAXXYT25Z2VAPHP0X7YEYCJXGWAG6UG9ZU6NQ+EX1DRD6UEC",
    "callbackUrl": "https://example.com/callback"
  }
}" http://localhost:8000/jsonrpc
```

#### Successful response:
```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "id": 123,
    "bip21": "bitcoin:bcrt1q5f6jz3hn9nv3wx3sjgea5p37yldc5p3xrphau4?amount=0.001&pjos=0&pj=HTTPS://PAYJO.IN/DY0LZN5AKK8FJ%23RK1QTVMMHJ8PPST9HCYZENL87YHCCNVNU2S5PF789HMXHGHLR4FUFN8S+OH1QYPM59NK2LXXS4890SUAXXYT25Z2VAPHP0X7YEYCJXGWAG6UG9ZU6NQ+EX1DRD6UEC",
    "amount": "100000",
    "address": "bcrt1q5f6jz3hn9nv3wx3sjgea5p37yldc5p3xrphau4",
    "txid": "e8a72e7b254ff0d10515a7fc840a34832d0c4fa1558138fe58c0c8c2dcad61b7",
    "fee": "2500",
    "status": "completed",
    "confirmedTs": "2025-03-25T21:45:12.342Z",
    "cancelledTs": null,
    "callbackUrl": "https://example.com/callback/123",
    "calledBackTs": "2025-03-25T21:45:15.789Z",
    "createdTs": "2025-03-25T21:44:55.123Z",
    "updatedTs": "2025-03-25T21:45:15.789Z"
  }
}
```

#### Error responses:
```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "error": {
    "code": -32602,
    "message": "Invalid BIP21 URI",
    "data": null
  }
}
```

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "error": {
    "code": -32603,
    "message": "Unknown error",
    "data": "..."
  }
}
```

## Other useful commands

#### Start dev mode:
This will start a send container and a receive container so you can test sending and receiving payjoin requests between 2 different bitcoin core wallets.
```bash
docker-compose -f cypherapps/docker-compose.dev.yaml up -d
```

#### In dev mode:

```bash
address=$(docker exec $(docker ps --filter "name=bitcoin" --format "{{.ID}}") bitcoin-cli -rpcwallet=spending06.dat getnewaddress)
uri=$(curl -s -H 'Content-Type: application/json' -d "{"jsonrpc":2, "id":1, "method":"receive", "params":{"address": "${address}", "amount": 100000}}" http://localhost:8000/jsonrpc | jq -cr '.result.bip21')
```

Create a Payjoin receive request without providing an address
```bash
uri=$(curl -s -H 'Content-Type: application/json' -d '{"jsonrpc":2, "id":1, "method":"receive", "params":{"amount": 1000000}}' http://localhost:8000/jsonrpc | jq -cr '.result.bip21')
```

Send a Payjoin transaction
```bash
curl -H 'Content-Type: application/json' -d "{"jsonrpc":2, "id":1, "method":"send", "params":{"bip21":"${urijson}"}}" http://localhost:8001/send
```
