import { IResponseError } from "../jsonrpc/IResponseMessage";

export default interface IRespUnwatchTxid {
  result?: {
    event: string;
    id?: number;
    txid?: string;
    unconfirmedCallbackURL?: string;
    confirmedCallbackURL?: string;
  };
  error?: IResponseError<never>;
}



