import IReqUnwatchId from "./IReqUnwatchId";

export interface IReqUnwatchTxidProps {
  txid: string;
  confirmedCallbackURL?: string;
  xconfCallbackURL?: string;
}

export type IReqUnwatchTxid = IReqUnwatchId | IReqUnwatchTxidProps;

export default IReqUnwatchTxid;
