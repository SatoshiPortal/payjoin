export default interface IWasabiUtxo {
  txid: string;
  index: number;
  amount: number;
  anonymityScore: number;
  confirmed: boolean;
  confirmations: number;
  label: string;
  keyPath: string;
  address: string;
}
