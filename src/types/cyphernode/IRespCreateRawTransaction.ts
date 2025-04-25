import { IResponseError } from "../jsonrpc/IResponseMessage";

export default interface IRespCreateRawTransaction {
  result?: {
    hex: string;
  };
  error?: IResponseError<never>;
}
