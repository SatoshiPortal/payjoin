import { IResponseError } from "../jsonrpc/IResponseMessage";

export default interface IRespFundRawTransaction {
  result?: {
    hex: string;
    fee: number;
    changepos: number;
  };
  error?: IResponseError<never>;
}
