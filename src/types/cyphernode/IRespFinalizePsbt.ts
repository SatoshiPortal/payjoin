import { IResponseError } from "../jsonrpc/IResponseMessage";

export default interface IRespFinalizePsbt {
  result?: {
    psbt?: string;
    hex?: string;
    complete: boolean;
  };
  error?: IResponseError<never>;
}