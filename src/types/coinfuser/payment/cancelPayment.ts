import { IResponseError } from "../../jsonrpc/IResponseMessage";

export interface IReqCancelPayment {
  id: number;
}

export interface IRespCancelPayment {
  result?: { success: boolean };
  error?: IResponseError<never>;
}
