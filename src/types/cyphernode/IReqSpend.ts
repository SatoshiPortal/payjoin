export default interface IReqSpend {
  // - address, required, desination address
  // - amount, required, amount to send to the destination address

  address: string;
  amount: string | number;
  confTarget?: number;
  replaceable?: boolean;
  subtractfeefromamount?: boolean;
}
