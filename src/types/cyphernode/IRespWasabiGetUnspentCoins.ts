import { IResponseError } from "../jsonrpc/IResponseMessage";
import IWasabiUtxo from "./IWasabiUtxo";

export default interface IRespWasabiGetUnspentCoins {
  result?: {
    instanceId: number | null;
    unspentcoins: IWasabiUtxo[];
  };
  error?: IResponseError<never>;
}
