import { IResponseError } from "./IResponseMessage";

export default interface IResp {
  result?: any;
  error?: IResponseError<any>;
}