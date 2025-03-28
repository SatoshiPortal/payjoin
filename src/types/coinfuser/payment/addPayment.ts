import { IResponseError } from "../../jsonrpc/IResponseMessage";
import { IPayment } from "./payment";

export interface IReqAddPayment {
  address: string;
  amount: bigint;
  callbackUrl?: string;
}

export interface IRespAddPayment {
  result?: IPayment;
  error?: IResponseError<never>;
}
