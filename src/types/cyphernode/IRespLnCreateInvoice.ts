// ln_createinvoice response from Cyphernode:
// # {
// #   "id":"",
// #   "label":"",
// #   "bolt11":"",
// #   "connectstring":"",
// #   "callbackUrl":"",
// #   "payment_hash":"",
// #   "msatoshi":,
// #   "status":"unpaid",
// #   "description":"",
// #   "expires_at":
// # }

import { IResponseError } from "../jsonrpc/IResponseMessage";

export interface LnCreateInvoice {
  id: number;
  label: string;
  bolt11: string;
  connectstring: string;
  callbackUrl: string;
  payment_hash: string;
  msatoshi: number;
  status: string;
  description: string;
  expires_at: number;
}

export default interface IRespLnCreateInvoice {
  result?: LnCreateInvoice;
  error?: IResponseError<never>;
}
