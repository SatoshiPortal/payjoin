import { IResponseError } from "../jsonrpc/IResponseMessage";

export default interface IRespWasabiPayInCoinJoin {
  result?: {
    address: string;
    amount: number;
    instanceId: number;
    paymentId: string;
    status: string;
  };
  error?: IResponseError<never>;
}
