export interface IReqSendRawTransaction {
  hex: string
  maxfeerate?: number;
  wallet?: string;
}