import { IResponseError } from "../jsonrpc/IResponseMessage";

export default interface IRespCreateFundedPsbt {
  result?: {
    psbt: string;
    fee: number;
    changepos: number;
  };
  error?: IResponseError<never>;
}
