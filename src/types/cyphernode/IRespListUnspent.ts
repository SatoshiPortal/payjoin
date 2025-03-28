import { IResponseError } from "../jsonrpc/IResponseMessage";

export default interface IRespListUnspent {
  result?: {
    utxos: {
      txid: string;
      vout: number;
      address: string;
      label: string;
      scriptPubKey: string;
      amount: number;
      confirmations: number;
      spendable: boolean;
      solvable: boolean;
      safe: boolean;
    }[];
  };
  error?: IResponseError<never>;
}