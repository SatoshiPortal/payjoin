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
  status: string; // @todo update this to a specific enum
  confirmedTs?: Date;
  cancelledTs?: Date;
  callbackUrl?: string;
  calledBackTs?: string;
  createdTs: Date;
  updatedTs: Date;
}