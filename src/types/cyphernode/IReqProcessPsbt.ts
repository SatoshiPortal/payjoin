export interface IReqProcessPsbt {
  psbt: string;
  sign?: boolean;
  finalize?: boolean;
  wallet?: string;
}