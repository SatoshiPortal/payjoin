import { IResponseError } from "../jsonrpc/IResponseMessage";

export default interface IRespGetNewAddress {
  result?: {
    address: string;
  };
  error?: IResponseError<never>;
}
