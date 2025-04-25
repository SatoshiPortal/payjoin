import { IResponseError } from "../jsonrpc/IResponseMessage";
import IAddress from "./IAddress";

export default interface IRespWasabiGetNewAddress {
  result?: IAddress;
  error?: IResponseError<never>;
}
