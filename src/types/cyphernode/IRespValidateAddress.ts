import { IResponseError } from "../jsonrpc/IResponseMessage";

export default interface IRespValidateAddress {
  result?: {
    isvalid: boolean;
    address?: string;
    scriptPubKey?: string;
    isscript?: boolean;
    iswitness?: boolean;
  };
  error?: IResponseError<never>;
}
