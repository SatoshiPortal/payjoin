import { IResponseError } from "../jsonrpc/IResponseMessage";

export default interface IRespWatchTxid {
  result?: {
    id: number;
    event: string;
    inserted: number;
    txid: string;
    confirmedCallbackURL: string;
    xconfCallbackURL: string;
    nbxconf: number;
  }
  error?: IResponseError<any>
}