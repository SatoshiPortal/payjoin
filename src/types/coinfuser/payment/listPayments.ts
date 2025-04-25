import { IResponseError } from "../../jsonrpc/IResponseMessage";
import { IPayment } from "./payment";

export interface IReqListPayments {
  txid?: string;
  confirmed?: boolean;
  cancelled?: boolean;
  createdFromTs?: Date;
  createdToTs?: Date;
  limit?: number;
  offset?: number;
}

export type IRespListPayments = {
  result?: IPayment[];
  error?: IResponseError<never>;
};
