import { IResponseError } from "../jsonrpc/IResponseMessage";

export default interface IRespWatch {
  result?: {
    id: number;
    event: string;
    imported: number;
    inserted: number;
    address: string;
    unconfirmedCallbackURL: string;
    confirmedCallbackURL: string;
    label: string;
    estimatesmartfee2blocks: number;
    estimatesmartfee6blocks: number;
    estimatesmartfee36blocks: number;
    estimatesmartfee144blocks: number;
    eventMessage: string;
  };
  error?: IResponseError<never>;
}
