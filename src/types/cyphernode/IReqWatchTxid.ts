export default interface IReqWatchTxid {
  txid: string;
  confirmedCallbackURL: string;
  xconfCallbackURL: string;
  nbxconf: number;
} 