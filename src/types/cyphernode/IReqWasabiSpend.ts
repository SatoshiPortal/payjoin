import IReqSpend from "./IReqSpend";

// - instanceId: integer, optional
// - private: boolean, optional, default=false
// - address: string, required
// - amount: number in BTC, required
// - minanonset: number, optional
// - label: number, optional
// - confTarget: number, optional

type IReqWasabiSpend = Omit<IReqSpend, "replaceable" | "subtractfeefromamount"> & {
  instanceId?: number;
  private?: boolean;
  minanonset?: number;
  label?: string;
};

export default IReqWasabiSpend;
