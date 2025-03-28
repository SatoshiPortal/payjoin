import { IResponseError } from "../jsonrpc/IResponseMessage";

export interface IWasabiBalance {
  private: number;
  total: number;
}

export interface IWasabiBalances {
  [key: string]: IWasabiBalance;
}

export default interface IRespWasabiGetBalances {
  result?: IWasabiBalances;
  error?: IResponseError<never>;
}
