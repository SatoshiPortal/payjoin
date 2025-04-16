export interface CreateFundedPsbtOptions {
  add_inputs?: boolean;
  include_unsafe?: boolean;
  changeAddress?: string;
  includeWatching?: boolean;
  lockUnspents?: boolean;
  fee_rate?: number; // sat/vB
  feeRate?: number; // BTC/KvB
  subtractFeeFromOutputs?: number[];
  replaceable?: boolean;
  conf_target?: number;
  estimate_mode?: string;
}

export interface IReqCreateFundedPsbt {
  inputs: { txid: string; vout: number; sequence?: number }[];
  outputs: { [address: string]: number | string };
  locktime?: number;
  options?: CreateFundedPsbtOptions;
  wallet?: string;
}