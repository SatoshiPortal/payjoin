import { IResponseError } from "../jsonrpc/IResponseMessage";
import ITx from "./ITx";

export default interface IRespElementsSpend {
  result?: ITx;
  error?: IResponseError<never>;
}
