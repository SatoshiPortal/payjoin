import { IResponseError } from "../../jsonrpc/IResponseMessage";
import { IPayment } from "./payment";

export interface IReqGetPayment {
  id: number;
}

export interface IRespGetPayment {
  result?: IPayment;
  error?: IResponseError<never>;
}
