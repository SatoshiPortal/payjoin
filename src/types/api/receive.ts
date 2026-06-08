import { ReceiveStatus, TxEntry } from "../payjoin";

export interface IReqReceive {
  address?: string;
  amount: bigint;
  callbackUrl?: string;
}

export interface IRespReceive {
  id: number;
  bip21: string | null;
  amount: bigint;
  address: string;
  txid: string | null;
  fee: bigint | null;
  receiverFee: bigint | null;
  receiverInAmount: bigint | null;
  receiverOutAmount: bigint | null;
  senderInAmount: bigint | null;
  senderOutAmount: bigint | null;
  txInputs: TxEntry[] | null;
  txOutputs: TxEntry[] | null;
  status: ReceiveStatus;
  callbackUrl: string | null;
  calledBackTs: Date | null;
  expiryTs: Date | null;
  cancelledTs: Date | null;
  ohttpRelay: string | null;
  firstSeenTs: Date | null;
  fallbackTs: Date | null;
  nonPayjoinTs: Date | null;
  confirmedTs: Date | null;
  failedTs: Date | null;
  failedReason: string | null;
  createdTs: Date;
  updatedTs: Date;
}
