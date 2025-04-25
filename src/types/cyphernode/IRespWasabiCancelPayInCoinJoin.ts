import { IResponseError } from "../jsonrpc/IResponseMessage";

// {"success":true,"paymentId":"edca009b-b886-4e20-9174-9f933e2384b4","instanceId":0}
export default interface IRespWasabiCancelPayInCoinJoin {
  result?: {
    success: boolean;
    paymentId: string;
    instanceId: number;
  };
  error?: IResponseError<never>;
}
