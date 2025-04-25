import { IResponseError } from "../jsonrpc/IResponseMessage";

export interface IRespLnPaySuccessResult {
  destination: string;
  payment_hash: string;
  created_at: number;
  parts: number;
  msatoshi: bigint;
  amount_msat: string;
  msatoshi_sent: bigint;
  amount_sent_msat: string;
  payment_preimage: string;
  status: string;
}

export interface IRespLnPayAttempt {
  status: string;
  failreason: string;
  partid: number;
  amount: string;
}

export interface IRespLnPayFailureResult {
  code: number;
  message: string;
  attempts: IRespLnPayAttempt[];
}

export default interface IRespLnPay {
  result?: IRespLnPaySuccessResult | IRespLnPayFailureResult;
  error?: IResponseError<never>;
}
