import { IResponseError } from "../../jsonrpc/IResponseMessage";

export interface IReqGetNewAddress {
  label?: string;
  noPremix?: boolean;
  premixTag?: string;
}

export interface IRespGetNewAddress {
  result?: { address: string };
  error?: IResponseError<never>;
}
