
export default interface IReqWatch {
  address: string;
  confirmedCallbackURL: string;
  unconfirmedCallbackURL?: string;
  eventMessage?: string;
  label?: string;
} 