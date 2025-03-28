import { IResponseError } from "../jsonrpc/IResponseMessage";

export default interface IRespWasabiSpend {
  result?: {
    txid: string;
    tx: string;
    status: string;
    details: {
      address: string;
      amount: string;
      size: number;
      vsize: number;
      replaceable: boolean;
      fee: number;
    };
  };
  error?: IResponseError<never>;
}
