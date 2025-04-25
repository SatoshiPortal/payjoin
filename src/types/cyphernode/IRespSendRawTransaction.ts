import { IResponseError } from "../jsonrpc/IResponseMessage";

export default interface IRespSendRawTransaction {
  result?: string;
  error?: IResponseError<never>;
};