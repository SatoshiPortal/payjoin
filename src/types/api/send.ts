import { SendStatus, TxEntry } from "../payjoin";

export interface IReqSend {
  bip21: string;
  callbackUrl?: string;
}

export interface IRespSend {
  id: number;
  bip21: string;
  amount: bigint;
  address: string | null;
  txid: string | null;
  fee: bigint | null;
  senderFee: bigint | null;
  senderInAmount: bigint | null;
  senderOutAmount: bigint | null;
  receiverInAmount: bigint | null;
  receiverOutAmount: bigint | null;
  txInputs: TxEntry[] | null;
  txOutputs: TxEntry[] | null;
  status: SendStatus;
  callbackUrl: string | null;
  calledBackTs: Date | null;
  expiryTs: Date | null;
  cancelledTs: Date | null;
  ohttpRelay: string | null;
  confirmedTs: Date | null;
  createdTs: Date;
  updatedTs: Date;
}
