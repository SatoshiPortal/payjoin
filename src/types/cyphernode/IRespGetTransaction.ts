import { IResponseError } from "../jsonrpc/IResponseMessage";

export interface ITxVin {
  coinbase: string;
  txinwitness: string[];
  sequence: number;
}

export interface ITxVout {
  value: number;
  n: number;
  scriptPubKey: {
    asm: string;
    desc: string;
    hex: string;
    address: string;
    type: string;
  };
}

export interface ITx {
  txid: string;
  hash: string;
  version: number;
  size: number;
  vsize: number;
  weight: number;
  locktime: number;
  vin: ITxVin[];
  vout: ITxVout[];
  hex: string;
  blockhash: string;
  confirmations: number;
  time: number;
  blocktime: number;
}

export default interface IRespGetTransaction {
  result?: ITx;
  error?: IResponseError<never>;
}
