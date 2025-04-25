export interface IReqFinalizePsbt {
  psbt: string;
  extract?: boolean;
  wallet?: string;
}