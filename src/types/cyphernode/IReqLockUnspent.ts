
export interface IReqLockUnspent {
  unlock?: boolean;
  utxos: {
    txid: string;
    vout: number;
  }[];
  wallet?: string;
}