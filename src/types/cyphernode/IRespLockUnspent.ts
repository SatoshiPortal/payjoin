import { IResponseError } from "../jsonrpc/IResponseMessage";

export default interface IRespFundRawTransaction {
  result?: {
    success: boolean;
  };
  error?: IResponseError<never>;
}
