# Payjoin Cypherapp (MVP)

This payjoin cypherapp is a basic implementation that makes use of payjoin-cli from https://github.com/payjoin/rust-payjoin. The container will run a `payjoin-cli resume` process in the background as well as a simlpe HTTP server that will accept Payjoin requests and attempt to process them.

The API is simple and handles two request types: send and receive.

Due to the sled db that payjoin-cli uses only one process can run at a time (caused by locking on the db). To handle this when a request is received we kill the running `payjoin-ci resume` process and start a new process running the relevant command. The app also implements locking so only a single request can be processed at a time. To work around this limitation we can either run multiple instances of this app or handle queuing on the client side. Once the request is processed the `payjoin-cli resume` process is started again to listen and/or process any outstanding "sessions".

If the sled db has no outstanding sessions the `payjoin-cli resume` process will exit. We periodically (every 30 seconds) restart the process.


## API


### Receive

Create a Payjoin receive request with address provided:
```bash
curl -d "{\"address\": \"bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq\", \"amount\": 10000000}" http://localhost:8000/receive
```
_Note: when an address is provided in this way payjoin has no way to verify the address belongs to one of our wallets. This API should be locked down as much as possible_


Create a Payjoin receive request without providing an address:
```bash
curl -d "{\"amount\": 10000000}" http://localhost:8000/receive
```

#### Successful response:
```json
{
  "uri": "bitcoin:bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq?amount=0.1&pjos=0&pj=HTTPS://PAYJO.IN/ZFV5JGYXKQ3NX%23RK1QVLSWLM5USRWPADY9GQC0UMKAPSXE8GSJCYG23RHJ3WUERW08RAUC+OH1QYPM59NK2LXXS4890SUAXXYT25Z2VAPHP0X7YEYCJXGWAG6UG9ZU6NQ+EX1DRE27EC"
}
```

#### Error responses:
```json
{
  "error": "Invalid amount format"
}
```
```json
{
  "error": "Invalid address format"
}
```

```json
{
  "error": "Unknown error", "output":"..."
}
```

```json
{
  "error": "Operation timed out after ${timeout} seconds", "output":"..."
}
```
_Note: The Operation timed out error doesn't necessarily mean the request failed. The request may still be processed by the payjoin-cli resume process when the other participant comes online_

```json
{
  "error": "Problem acquiring lock. Please try again"
}
```

```json
{
  "error": "Failed to get valid response"
}
```

### Send

Send a Payjoin transaction:
```bash
curl -d "{\"uri\":\"bitcoin:bcrt1q5f6jz3hn9nv3wx3sjgea5p37yldc5p3xrphau4?amount=0.001&pjos=0&pj=HTTPS://PAYJO.IN/DY0LZN5AKK8FJ%23RK1QTVMMHJ8PPST9HCYZENL87YHCCNVNU2S5PF789HMXHGHLR4FUFN8S+OH1QYPM59NK2LXXS4890SUAXXYT25Z2VAPHP0X7YEYCJXGWAG6UG9ZU6NQ+EX1DRD6UEC\"}" http://localhost:8000/send
```
_You can also include a `feerate` property in the JSON object to specify the fee rate in sat/vbyte_

#### Successful response:
```json
{
  "status": "completed", "txid": "e8a72e7b254ff0d10515a7fc840a34832d0c4fa1558138fe58c0c8c2dcad61b7"
}
```

#### Error responses:
```json
{
  "error": "Invalid BIP21 URI"
}
```

```json
{
  "error": "Invalid fee rate format"
}
```

```json
{
  "error": "Unknown error", "output":"..."
}
```

```json
{
  "error": "Operation timed out after ${timeout} seconds", "output":"..."
}
```
_Note: The Operation timed out error doesn't necessarily mean the request failed. The request may still be processed by the payjoin-cli resume process when the other participant comes online_

```json
{
  "error": "Problem acquiring lock. Please try again"
}
```

```json
{
  "error": "Failed to get valid response"
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
urijson=$(curl -s -d "{\"address\": \"${address}\", \"amount\": 100000}" http://localhost:8000/receive | jq -cr)
```

Create a Payjoin receive request without providing an address
```bash
urijson=$(curl -s -d '{"amount": 1000000}' http://localhost:8000/receive | jq -cr)
```

Send a Payjoin transaction
```bash
curl -d "${urijson}" http://localhost:8001/send
```
