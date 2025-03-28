export interface IPayment {
  id: number;
  address: string;
  amount: bigint | string;
  txid?: string;
  confirmedTs?: Date;
  cancelledTs?: Date;
  callbackUrl?: string;
  calledBackTs?: Date;
  createdTs: Date;
  updatedTs: Date;
}
