import { CoinfuserClient } from "./CoinfuserClient";
import { CyphernodeClient } from "./CyphernodeClient";
import { config } from "../config";

describe("CoinfuserClient", () => {
  let client: CoinfuserClient;
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  let cnClient: CyphernodeClient;

  beforeAll(async () => {
    client = new CoinfuserClient(config);
    cnClient = new CyphernodeClient(config);
  });

  test("should get a new address", async () => {
    const response = await client.getNewAddress();

    expect(response).toHaveProperty("result");
    expect(response.result).toEqual(
      expect.objectContaining({
        address: expect.any(String),
      }),
    );
  }, 30000);

  test("should add a payment", async () => {
    const addressResponse = await cnClient.getnewaddress();
    if (!addressResponse.result) throw new Error("Failed to get new address");
    const { address } = addressResponse.result;

    expect(address).toEqual(expect.any(String));

    const response = await client.addPayment({
      address: address,
      amount: 10000n,
    });

    expect(response).toHaveProperty("result");

    expect(response.result).toEqual(
      expect.objectContaining({
        id: expect.any(Number),
        address: expect.any(String),
        amount: expect.any(String),
        txid: null,
      }),
    );
  }, 30000);

  test("should get a payment", async () => {
    const addressResponse = await cnClient.getnewaddress();
    if (!addressResponse.result) throw new Error("Failed to get new address");
    const { address } = addressResponse.result;

    expect(address).toEqual(expect.any(String));

    const addPaymentResponse = await client.addPayment({
      address: address,
      amount: 10000n,
    });

    expect(addPaymentResponse).toHaveProperty("result");

    expect(addPaymentResponse.result).toEqual(
      expect.objectContaining({
        id: expect.any(Number),
      }),
    );

    const response = await client.getPayment({
      id: addPaymentResponse.result!.id,
    });

    expect(response).toHaveProperty("result");

    expect(response.result).toEqual(
      expect.objectContaining({
        id: expect.any(Number),
        address: expect.any(String),
        amount: expect.any(String),
        txid: null,
      }),
    );
  }, 30000);

  test("should cancel a payment", async () => {
    const addressResponse = await cnClient.getnewaddress();
    if (!addressResponse.result) throw new Error("Failed to get new address");
    const { address } = addressResponse.result;

    expect(address).toEqual(expect.any(String));

    const addPaymentResponse = await client.addPayment({
      address: address,
      amount: 10000n,
    });

    expect(addPaymentResponse).toHaveProperty("result");

    expect(addPaymentResponse.result).toEqual(
      expect.objectContaining({
        id: expect.any(Number),
      }),
    );

    const response = await client.cancelPayment({
      id: addPaymentResponse.result!.id,
    });

    expect(response).toHaveProperty("result");

    expect(response.result).toEqual(
      expect.objectContaining({
        success: true,
      }),
    );
  }, 30000);

  test("should list payments", async () => {
    const response = await client.listPayments({});

    expect(response).toHaveProperty("result");

    expect(response.result).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: expect.any(Number),
          address: expect.any(String),
          amount: expect.any(String),
          txid: null,
        }),
      ]),
    );
  }, 30000);

  test("should process outstanding payments in a transaction", async () => {
    const addressResponse = await cnClient.getnewaddress();
    if (!addressResponse.result) throw new Error("Failed to get new address");
    const { address } = addressResponse.result;

    expect(address).toEqual(expect.any(String));

    const addPaymentResponse = await client.addPayment({
      address: address,
      amount: 10000n,
    });

    expect(addPaymentResponse).toHaveProperty("result");

    expect(addPaymentResponse.result).toEqual(
      expect.objectContaining({
        id: expect.any(Number),
      }),
    );

    const response = await client.processTransaction();

    expect(response).toHaveProperty("result");

    expect(response.result).toEqual(
      expect.objectContaining({
        success: true,
      }),
    );
  }, 30000);

  test("should process premix utxos", async () => {
    const response = await client.processPremix();

    expect(response).toHaveProperty("result");

    expect(response.result).toEqual(
      expect.objectContaining({
        success: true,
      }),
    );
  }, 30000);

  test("should get coinfuser balance", async () => {
    const response = await client.getBalance();

    expect(response).toHaveProperty("result");

    expect(response.result).toEqual(
      expect.objectContaining({
        balance: expect.any(Number),
      }),
    );
  }, 30000);
});
