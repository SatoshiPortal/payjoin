import { IResponseError } from "../jsonrpc/IResponseMessage";

export interface WasabiListPayInCoinJoinPaymentState {
  status: "Pending" | "In progress" | "Finished";
}
export interface WasabiListPayInCoinJoinPayment {
  id: string;
  amount: number;
  destination: string;
  state: WasabiListPayInCoinJoinPaymentState[];
  address: string;
}

export default interface IRespWasabiListPayInCoinJoin {
  result?: {
    payments: WasabiListPayInCoinJoinPayment[];
    instanceId: number;
  };
  error?: IResponseError<never>;
}
