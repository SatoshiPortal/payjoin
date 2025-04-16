import { IResponseError } from "../jsonrpc/IResponseMessage";

export default interface IRespProcessPsbt {
  result?: {
    psbt: string;
    complete: boolean;
  };
  error?: IResponseError<never>;
}
