import { config } from "../config";
import { PayjoinOhttpKeys, PayjoinReceiver } from "payjoin-ts";

export async function getOhttpKeys() {
  const ohttpKeys = await PayjoinOhttpKeys.fetch(config.OHTTP_RELAY, config.PAYJOIN_DIRECTORY);
  return ohttpKeys.toBytes();
}

export async function createReceiver(address: string, amount: bigint): Promise<{ receiver: PayjoinReceiver, bip21: string }> {
  const ohttpKeys = await getOhttpKeys();

  const receiver = new PayjoinReceiver(
    address,
    config.PAYJOIN_DIRECTORY,
    ohttpKeys,
    config.OHTTP_RELAY,
    config.PAYJOIN_EXPIRY,
  );

  const uriBuilder = receiver.pjUriBuilder().amount(Number(amount));
  const bip21 = uriBuilder.build();

  return { receiver, bip21 };
}