import { ReceiveStatus } from "../payjoin";

export interface IReqReceive {
  address?: string;
  amount: bigint;
  callbackUrl?: string;
}

export interface IRespReceive {
  id: number;
  bip21: string;
  amount: bigint;
  address: string;
  txid?: string | null;
  status: ReceiveStatus
  expiryTs: Date | null;
  confirmedTs?: Date | null;
  cancelledTs?: Date | null;
  callbackUrl?: string | null;
  calledBackTs?: Date;
  createdTs: Date;
  updatedTs: Date;
}