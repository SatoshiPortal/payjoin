import { CyphernodeClient } from "./CyphernodeClient";
import { config } from "../config";

describe("CyphernodeClient", () => {
  let client: CyphernodeClient;
  let batchAddress: any;
  let batchOutputId: number;
  let batcherId: number;

  beforeAll(async () => {
    client = new CyphernodeClient(config);

    batchAddress = await client.getnewaddress({ addressType: "bech32", label: "batchtest" });
  });

  test("should reload config", async () => {
    const response = await client.configureCyphernode(config);

    expect(response).toBe(undefined);
  });

  test("_generateToken", () => {
    expect(typeof client._generateToken()).toBe("string");
  });

  test("_post 401 Unauthorized", async () => {
    // test calling an invalid endpoint with post
    // an error object with a status of 401 should be returned

    const localConf = config;
    // change API key to an invalid one
    localConf.CN_API_ID = "invalid";
    // set up a new client with the invalid API key
    const localClient = new CyphernodeClient(localConf);

    const result = await localClient._post("/invalidendpoint", { test: "test" });

    expect(result).toHaveProperty("status");
    expect(result.status).toBe(401);
  });

  test("_post 403", async () => {
    // test calling an invalid endpoint with post
    // an error object with a status of 403 should be returned
    const result = await client._post("/invalidendpoint", { test: "test" });

    expect(result).toHaveProperty("status");
    expect(result.status).toBe(403); // Shouldn't this actually get getting a 403?
  });

  test("_post with no response", async () => {
    const configCopy = { ...config, CN_URL: "http://fake:9999" };
    const clientCopy = new CyphernodeClient(configCopy);

    // test calling an invalid endpoint with post
    // an error object with a status of 404 should be returned
    const result = await clientCopy._post("/invalidendpoint", { test: "test" }, { dummy: "dummy" });

    expect(result).toHaveProperty("status");
    expect(result.status).toBe(-1);
  });

  test("_get 401 Unauthorized", async () => {
    // test calling an invalid endpoint with post
    // an error object with a status of 401 should be returned

    const localConf = config;
    // change API key to an invalid one
    localConf.CN_API_ID = "invalid";
    // set up a new client with the invalid API key
    const localClient = new CyphernodeClient(localConf);

    const result = await localClient._get("/invalidendpoint");

    expect(result).toHaveProperty("status");
    expect(result.status).toBe(401);
  });

  test("_get 403", async () => {
    // test calling an invalid endpoint with post
    // an error object with a status of 403 should be returned
    const result = await client._get("/invalidendpoint");

    expect(result).toHaveProperty("status");
    expect(result.status).toBe(403); // Shouldn't this actually get getting a 403?
  });

  test("_get with no response", async () => {
    const configCopy = { ...config, CN_URL: "http://fake:9999" };
    const clientCopy = new CyphernodeClient(configCopy);

    // test calling an invalid endpoint with post
    // an error object with a status of 404 should be returned
    const result = await clientCopy._get("/invalidendpoint", { dummy: "dummy" });

    expect(result).toHaveProperty("status");
    expect(result.status).toBe(-1);
  });

  test("should getblockchaininfo", async () => {
    const response = await client.getblockchaininfo();

    expect(response).toHaveProperty("result");
    expect(response.result).toHaveProperty("chain");
  });

  test("should watch an address", async () => {
    // test watching an address
    // a result object with a status of 200 should be returned
    const response = await client.watch({
      address: "2MzQwSSnBHWHqSAqtTVQ6v47XtaisrJa1Vc",
      confirmedCallbackURL: "https://example.com/confirmed",
    });

    expect(response).toHaveProperty("result");
    expect(response.result).toHaveProperty("id");
    expect(response.result).toHaveProperty("event");
    expect(response.result).toHaveProperty("address");
  });

  test("should fail to watch a bad address", async () => {
    // test watching an address
    // a result object with a status of 200 should be returned
    const response = await client.watch({
      address: "-",
      confirmedCallbackURL: "https://example.com/confirmed",
    });

    expect(response).toHaveProperty("error");
    expect(response.error).toHaveProperty("code");
    expect(response.error?.code).toBe(-5);
    expect(response.error).toHaveProperty("message");
    expect(response.error?.message).toBe("Invalid address");
  });

  // unwatch tests
  test("should unwatch an address", async () => {
    // test unwatching an address
    // a result object with a status of 200 should be returned
    const response = await client.unwatch({
      address: "2MzQwSSnBHWHqSAqtTVQ6v47XtaisrJa1Vc",
    });

    expect(response).toHaveProperty("result");
    expect(response.result).toHaveProperty("event");
    expect(response.result).toHaveProperty("address");
    expect(response.result).toHaveProperty("confirmedCallbackURL");
  });

  test("should unwatch an address with a GET request", async () => {
    // test unwatching an address
    // a result object with a status of 200 should be returned
    const response = await client.unwatch("2MzQwSSnBHWHqSAqtTVQ6v47XtaisrJa1Vc");

    expect(response).toHaveProperty("result");
    expect(response.result).toHaveProperty("event");
    expect(response.result).toHaveProperty("address");
    expect(response.result).toHaveProperty("confirmedCallbackURL");
  });

  test("should watch a tx", async () => {
    // test watching an address
    // a result object with a status of 200 should be returned
    const response = await client.watchtxid({
      txid: "b081ca7724386f549cf0c16f71db6affeb52ff7a0d9b606fb2e5c43faffd3387",
      confirmedCallbackURL: "https://example.com/confirmed",
      xconfCallbackURL: "https://example.com/xconfirmed",
      nbxconf: 6,
    });

    expect(response).toHaveProperty("result");
    expect(response.result).toHaveProperty("id");
    expect(response.result).toHaveProperty("event");
    expect(response.result).toHaveProperty("txid");
  });

  test("should unwatch a txid", async () => {
    const response = await client.unwatchtxid({
      txid: "b081ca7724386f549cf0c16f71db6affeb52ff7a0d9b606fb2e5c43faffd3387",
      confirmedCallbackURL: "https://example.com/confirmed",
      xconfCallbackURL: "https://example.com/xconfirmed",
    });

    expect(response).toHaveProperty("result");
    expect(response.result).toHaveProperty("event");
    expect(response.result).toHaveProperty("txid");
    expect(response.result).toHaveProperty("confirmedCallbackURL");
  });

  test("should get total balance", async () => {
    // test getting spender balance
    // a result object with a status of 200 should be returned
    const response = await client.getbalance();

    expect(response).toHaveProperty("result");
    expect(response.result).toHaveProperty("balance");
    expect(typeof response.result?.balance).toBe("number");
  });

  test("should get a new bitcoin address", async () => {
    // test getting a new bitcoin address
    // a result object with a status of 200 should be returned
    const response = await client.getnewaddress();

    expect(response).toHaveProperty("result");
    expect(response.result).toHaveProperty("address");
    expect(typeof response.result?.address).toBe("string");
  });

  /*test("should get a new elements address", async () => {
    // test getting a new liquid network address
    // a result object with a status of 200 should be returned
    const response = await client.elementsGetNewAddress();

    expect(response).toHaveProperty("result");
    expect(response.result).toHaveProperty("address");
    expect(typeof response.result?.address).toBe("string");
  });*/

  test("should get a new bech32 bitcoin address using a GET request", async () => {
    // test getting a new bitcoin address
    // a result object with a status of 200 should be returned
    const response = await client.getnewaddress("bech32");

    expect(response).toHaveProperty("result");
    expect(response.result).toHaveProperty("address");
    expect(typeof response.result?.address).toBe("string");
  });

  test("should get a new bech32 bitcoin address using a POST request", async () => {
    // test getting a new bitcoin address
    // a result object with a status of 200 should be returned
    const response = await client.getnewaddress({ addressType: "bech32", label: "test" });

    expect(response).toHaveProperty("result");
    expect(response.result).toHaveProperty("address");
    expect(typeof response.result?.address).toBe("string");
  });

  test("should add a transfer to a batch", async () => {
    expect(batchAddress).toHaveProperty("result");
    expect(batchAddress.result).toHaveProperty("address");

    const response = await client.addToBatch({
      address: batchAddress.result?.address as string,
      amount: 0.001,
    });

    expect(response).toHaveProperty("result");
    expect(response.result).toEqual(
      expect.objectContaining({
        batcherId: expect.any(Number),
        nbOutputs: expect.any(Number),
        oldest: expect.any(String),
        outputId: expect.any(Number),
        total: expect.any(Number),
      }),
    );

    batchOutputId = response.result?.outputId as number;
    batcherId = response.result?.batcherId as number;
  });

  test("should get details about a batch", async () => {
    expect(batchAddress).toHaveProperty("result");
    expect(batchAddress.result).toHaveProperty("address");

    let localOutputId: number = 0;
    if (!batcherId) {
      const batch = await client.addToBatch({
        address: batchAddress.result?.address as string,
        amount: 0.0016,
      });

      batcherId = batch.result?.batcherId as number;
      localOutputId = batch.result?.outputId as number;
    }

    const response = await client.getBatchDetails({ batcherId });

    expect(response).toHaveProperty("result");
    expect(response.result).toEqual(
      expect.objectContaining({
        batcherId: expect.any(Number),
        nbOutputs: expect.any(Number),
        oldest: expect.any(String),
        total: expect.any(Number),
      }),
    );

    // clean up after ourselves so it doesn't get sent
    if (localOutputId > 0) {
      await client.removeFromBatch(localOutputId);
    }
  });

  test("should un-batch a request", async () => {
    expect(batchAddress).toHaveProperty("result");
    expect(batchAddress.result).toHaveProperty("address");

    if (!batchOutputId) {
      const batch = await client.addToBatch({
        address: batchAddress.result?.address as string,
        amount: 0.0015,
      });

      batchOutputId = batch.result?.outputId as number;
    }

    const response = await client.removeFromBatch(batchOutputId);

    expect(response).toHaveProperty("result");
    expect(response.result).toEqual(
      expect.objectContaining({
        batcherId: expect.any(Number),
        nbOutputs: expect.any(Number),
        oldest: expect.any(String),
        outputId: expect.any(Number),
        total: expect.any(Number),
      }),
    );
  });

  test("should spend a batch", async () => {
    expect(batchAddress).toHaveProperty("result");
    expect(batchAddress.result).toHaveProperty("address");

    const batch = await client.addToBatch({
      address: batchAddress.result?.address as string,
      amount: 0.00005,
    });

    const batcherId = batch.result?.batcherId as number;

    const response = await client.batchSpend({ batcherId });

    expect(response).toHaveProperty("result");
    expect(response.result).toEqual(
      expect.objectContaining({
        batcherId: expect.any(Number),
        nbOutputs: expect.any(Number),
        oldest: expect.any(String),
        total: expect.any(Number),
        txid: expect.any(String),
      }),
    );
  });

  test("should spend some funds", async () => {
    const address = await client.getnewaddress();

    expect(address).toHaveProperty("result");
    expect(address.result).toHaveProperty("address");

    if (!address.result?.address) {
      throw new Error("Address is undefined");
    }

    const response = await client.spend({
      address: address.result?.address,
      amount: "0.00001",
    });

    expect(response).toHaveProperty("result");
    expect(response.result).toHaveProperty("txid");
    expect(typeof response.result?.txid).toBe("string");
  }, 30000);

  test('should fail to create a raw transaction with an invalid address', async () => {
    const response = await client.createRawTransaction({
      inputs: [],
      outputs: {
        "invalid": 0.0001
      }
    });

    expect(response).toHaveProperty("error");
    expect(response.error).toHaveProperty("code");
    expect(response.error?.code).toBe(-32603);
    expect(response.error).toHaveProperty("message");
    expect(response.error?.message).toBe("Invalid Bitcoin address: invalid");
  });

  test("should fail to spend to an invalid address", async () => {
    const response = await client.spend({
      address: "invalid",
      amount: "0.001",
    });

    expect(response).toHaveProperty("error");
    expect(response.error).toHaveProperty("code");
    expect(response.error?.code).toBe(-32603);
    expect(response.error).toHaveProperty("message");
    expect(response.error?.message).toBe("Invalid Bitcoin address: invalid");
  });

  /*test("should spend some funds via elements", async () => {
    const address = await client.elementsGetNewAddress();

    expect(address).toHaveProperty("result");
    expect(address.result).toHaveProperty("address");

    if (!address.result?.address) {
      throw new Error("Address is undefined");
    }

    const response = await client.elementsSpend({
      address: address.result?.address,
      amount: "0.00001",
      assetId: liquidConfig.LBTC_ASSETID_LIQUIDV1,
    });

    expect(response).toHaveProperty("result");
    expect(response.result).toHaveProperty("txid");
    expect(typeof response.result?.txid).toBe("string");
  }, 30000);*/

  test.only("should validate an address", async () => {
    const response = await client.validateAddress("2MzQwSSnBHWHqSAqtTVQ6v47XtaisrJa1Vc");

    expect(response).toHaveProperty("result");
    expect(response.result).toHaveProperty("isvalid");
    expect(response.result).toHaveProperty("address");
  });
});
