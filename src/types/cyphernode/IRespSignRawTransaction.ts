import { IResponseError } from "../jsonrpc/IResponseMessage";

export default interface IRespSignRawTransaction {
  result?: {
    hex: string;
    complete: boolean;
    fee: number;
    feerate: number;
    errors: {
      txid: string;
      vout: number;
      scriptSig: string;
      sequence: number;
      error: string;
    }[];
  };
  error?: IResponseError<never>;
}