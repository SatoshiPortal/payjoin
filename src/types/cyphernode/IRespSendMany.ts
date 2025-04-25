import { IResponseError } from "../jsonrpc/IResponseMessage";

export default interface IRespSendMany {
  result?: {
    status: string;
    txid: string;
    hash: string;
    details: {
      amounts: {
        [key: string]: number;
      };
      tx_amount: number;
      firstseen: number;
      size: number;
      vsize: number;
      replaceable: boolean;
      fee: number;
    }
  };
  error?: IResponseError<never>;
};