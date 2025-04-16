import { SendStatus } from "../payjoin";

export interface IReqSend {
  bip21: string;
  callbackUrl?: string;
}

export interface IRespSend {
  id: number;
  bip21: string;
  amount: bigint;
  address: string;
  txid?: string;
  fee?: bigint;
  status: SendStatus
  confirmedTs?: Date;
  cancelledTs?: Date;
  callbackUrl?: string;
  calledBackTs?: Date;
  createdTs: Date;
  updatedTs: Date;
}