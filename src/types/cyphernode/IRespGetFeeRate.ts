import { IResponseError } from "../jsonrpc/IResponseMessage";

export default interface IRespGetFeeRate {
  result?: {
    feerate: string;
  };
  error?: IResponseError<never>;
}
