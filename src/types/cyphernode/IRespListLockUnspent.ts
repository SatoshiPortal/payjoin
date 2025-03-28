import { IResponseError } from "../jsonrpc/IResponseMessage";

export default interface IRespListLockUnspent {
  result?: {
    locked_utxos: {
      txid: string;
      vout: number;
    }[];
  };
  error?: IResponseError<never>;
}
