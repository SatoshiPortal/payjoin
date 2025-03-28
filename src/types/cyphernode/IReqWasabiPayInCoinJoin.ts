// - instanceId: integer, optional
// - address: string, required
// - amount: number in BTC, required

export default interface IReqWasabiPayInCoinJoin {
  instanceId?: number;
  address: string;
  amount: string;
}
