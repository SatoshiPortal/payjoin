import { IResponseError } from "../jsonrpc/IResponseMessage";

export default interface IRespTestMempoolAccept {
  result?: {
    txid: string;
    wtxid: string;
    allowed: boolean;
    vsize?: number;
    fees?: {
      base: number;
    };
    "reject-reason"?: string;
  }[];
  error?: IResponseError<never>;
}
