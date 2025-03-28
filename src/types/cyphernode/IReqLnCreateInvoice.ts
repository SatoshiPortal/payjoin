export default interface IReqLnCreateInvoice {
  // msatoshi, label, description, expiry, callbackUrl
  msatoshi: string | number;
  label: string;
  description: string;
  expiry: number;
  callbackUrl: string;
}
