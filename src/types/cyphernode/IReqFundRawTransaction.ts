export interface FundingTxOptions {
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

export interface IReqFundRawTransaction {
  hex: string;
  options: FundingTxOptions;
  wallet?: string;
}