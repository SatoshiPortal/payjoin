import { IResponseError } from "../jsonrpc/IResponseMessage";

export default interface IRespDecodeRawTransaction {
  result?: {
    tx: {
      txid: string;
      hash: string;
      version: number;
      size: number;
      vsize: number;
      weight: number;
      locktime: number;
      vin: {
        txid: string;
        vout: number;
        scriptSig: {
          asm: string;
          hex: string;
        };
        txinwitness: string[];
        sequence: number;
      }[];
      vout: {
        value: number;
        n: number;
        scriptPubKey: {
          asm: string;
          desc: string;
          hex: string;
          reqSigs: number;
          type: string;
          address?: string;
          addresses?: string[];
        };
      }[];
    }
  };
  error?: IResponseError<never>;
}


export interface s {
  
}