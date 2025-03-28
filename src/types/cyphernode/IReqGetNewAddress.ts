export interface IReqGetNewAddressProps {
  addressType?: "legacy" | "p2sh-segwit" | "bech32";
  label?: string;
  wallet?: string;
}

export type IReqGetNewAddress = string | IReqGetNewAddressProps;

export default IReqGetNewAddress;
