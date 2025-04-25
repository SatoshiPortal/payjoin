import { IResponseError } from "../../jsonrpc/IResponseMessage";

export interface IRespProcessTransaction {
  result?: { success: boolean };
  error?: IResponseError<never>;
}
