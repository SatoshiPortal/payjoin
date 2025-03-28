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
  txid?: string;
  status: string; // @todo update this to a specific enum
  expiryTs: Date;
  confirmedTs?: Date;
  cancelledTs?: Date;
  callbackUrl?: string;
  calledBackTs?: Date;
  createdTs: Date;
  updatedTs: Date;
}