
export interface IReqLockUnspent {
  unlock?: boolean;
  utxos: {
    txid: string;
    vout: number;
  }[];
  persistent?: boolean;
  wallet?: string;
}