export interface IReqSendMany {
  amounts: { [address: string]: number };
  subtractfeefromamount?: string[];
  replaceable?: boolean;
  conf_target?: number;
  estimate_mode?: string;
  fee_rate?: number;
  walletName: string;
}