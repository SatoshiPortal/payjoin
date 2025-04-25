export interface IReqCreateRawTransaction {
  inputs: { txid: string; vout: number; sequence?: number }[];
  outputs: { [address: string]: number | string };
  locktime?: number;
  replaceable?: boolean;
  wallet?: string;
}