# Payjoin Cypherapp

This payjoin cypherapp is a basic implementation that makes use of payjoin from https://github.com/payjoin/rust-payjoin and payjoin-typescript https://github.com/SatoshiPortal/payjoin-typescript.

The API is simple and handles two request types: send and receive.

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
            "address": "bcrt1qu2xt7tsqastdgv2pnresamwm4t6je5lgtmfkvh",
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
    "amount": 100000
  }
}' http://localhost:8000/jsonrpc | jq
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
    "fee": "0",
    "receiverFee": "0",
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

### Cancel Receive

Cancel a Payjoin receive request if it is still pending:
```bash
curl -X POST http://localhost:8000/jsonrpc \
     -H "Content-Type: application/json" \
     -d '{
          "jsonrpc": "2.0",
          "id": 1,
          "method": "cancelReceive",
          "params": {
            "id": 12
          }
        }' | jq
```

#### Successful response:
```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "id": 12
  }
}
```

#### Error response:
```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "error": {
    "code": -32602,
    "message": "Cannot cancel a confirmed receive session",
    "data": null
  }
}
```


### Get Receive

Get a Payjoin receive request
```bash
curl -X POST http://localhost:8000/jsonrpc \
     -H "Content-Type: application/json" \
     -d '{
          "jsonrpc": "2.0",
          "id": 1,
          "method": "getReceive",
          "params": {
            "id": 44
          }
        }' | jq
```

#### Successful response:
```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "id": 44,
    "bip21": "bitcoin:bcrt1q656qalna3lupmnmcfzmvwr0rpknx0u5kkx5c90?amount=0.001&pjos=0&pj=HTTPS://PAYJO.IN/74WUZDN6A7005%23RK1QGC58DXP88E5EPM6QD04XC689JTYHEWC49J6CNXARZ7TH74CA3K2X+OH1QYP87E2AVMDKXDTU6R25WCPQ5ZUF02XHNPA65JMD8ZA2W4YRQN6UUWG+EX1DXTSQ6Q",
    "address": "bcrt1q656qalna3lupmnmcfzmvwr0rpknx0u5kkx5c90",
    "amount": "100000",
    "txid": "c7b7f1a3c2c102fc45069097d4c8d2efddb301ddae7699dd50854f2cdf844b0a",
    "fee": "1463",
    "receiverFee": "0",
    "fallbackTxHex": "020000000001010e2007fb0e18aa4aae2be0edfa2ad1a01660537c3752cb2aa14622cba0b5eb3d0000000000fdffffff02c658b9000000000016001442ead3249a9caf2866c854984a620f3ca572b943a086010000000000160014d5340efe7d8ff81dcf7848b6c70de30da667f296024730440220593b826955236f020f9b840368d77537262015abbd614a862f6f70a77999e1da022000c6b2ab7a3ded1abb9e8a233d72c44da74843ea692ba08484db647c2e07a24d012103dc6f41ef283a00528f91159adb9f75dc46887279bf073d66520209725451749900000000",
    "callbackUrl": null,
    "calledBackTs": null,
    "expiryTs": "2025-04-17T05:53:45.907Z",
    "cancelledTs": null,
    "firstSeenTs": "2025-04-17T04:54:23.465Z",
    "fallbackTs": null,
    "confirmedTs": "2025-04-17T04:57:34.014Z",
    "createdTs": "2025-04-17T04:53:45.959Z",
    "updatedTs": "2025-04-17T04:57:34.015Z",
    "status": "confirmed"
  }
}
```

#### Error response:
```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "error": {
    "code": -32603,
    "message": "Failed to get receive",
    "data": null
  }
}
```


### Send

Send a Payjoin transaction:
```bash
curl -H 'Content-Type: application/json' \
 -d '{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "send",
  "params": {
    "bip21": "bitcoin:bcrt1qwr0ecgdmee9pyc4mk4286puvgakteuyu6kymew?amount=0.002&pjos=0&pj=HTTPS://PAYJO.IN/JRASJAZTXW3UW%23RK1QGMH9EY7Z33VMNGVEA6060ZN6CC4HXP0AHTVVE9RYX3L4J6HQRKAU+OH1QYP87E2AVMDKXDTU6R25WCPQ5ZUF02XHNPA65JMD8ZA2W4YRQN6UUWG+EX14TTSZ6Q",
    "callbackUrl": "https://example.com/callback"
  }
}' http://localhost:8000/jsonrpc | jq
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
    "senderFee": "2500",
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

### Cancel Send

Cancel a Payjoin send request if it is still pending:
```bash
curl -X POST http://localhost:8000/jsonrpc \
     -H "Content-Type: application/json" \
     -d '{
          "jsonrpc": "2.0",
          "id": 1,
          "method": "cancelSend",
          "params": {
            "id": 21
          }
        }' | jq
```

#### Successful response:
```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "id": 21
  }
}
```

#### Error response:
```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "error": {
    "code": -32602,
    "message": "Cannot cancel a confirmed send session",
    "data": null
  }
}
```


### Get Send

Get a Payjoin send request:
```bash
curl -X POST http://localhost:8000/jsonrpc \
     -H "Content-Type: application/json" \
     -d '{
          "jsonrpc": "2.0",
          "id": 1,
          "method": "getSend",
          "params": {
            "id": 21
          }
        }' | jq
```

#### Successful response:
```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "id": 21,
    "bip21": "bitcoin:bcrt1q5f6jz3hn9nv3wx3sjgea5p37yldc5p3xrphau4?amount=0.001&pjos=0&pj=HTTPS://PAYJO.IN/DY0LZN5AKK8FJ%23RK1QTVMMHJ8PPST9HCYZENL87YHCCNVNU2S5PF789HMXHGHLR4FUFN8S+OH1QYPM59NK2LXXS4890SUAXXYT25Z2VAPHP0X7YEYCJXGWAG6UG9ZU6NQ+EX1DRD6UEC",
    "amount": "100000",
    "address": "bcrt1q5f6jz3hn9nv3wx3sjgea5p37yldc5p3xrphau4",
    "txid": "e8a72e7b254ff0d10515a7fc840a34832d0c4fa1558138fe58c0c8c2dcad61b7",
    "fee": "2500",
    "senderFee": "2500",
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

#### Error response:
```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "error": {
    "code": -32603,
    "message": "Failed to get send"
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
