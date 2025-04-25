import { IResponseError } from "../jsonrpc/IResponseMessage";

export default interface IRespUnwatch {
  result?: {
    event: string;
    id?: number;
    address?: string;
    unconfirmedCallbackURL?: string;
    confirmedCallbackURL?: string;
  };
  error?: IResponseError<never>;
}

