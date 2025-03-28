import { IResponseError } from "../jsonrpc/IResponseMessage";

export default interface IRespGetBalance {
  result?: {
    balance: number;
  };
  error?: IResponseError<never>;
}
