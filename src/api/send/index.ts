import { addJsonRpcMethod } from "..";
import { IReqSend, IRespSend } from "../../types/api/send";

export function registerSendApi(): void {
  addJsonRpcMethod('send', send);
}

export async function send(params: IReqSend): Promise<IRespSend> {
  console.log('send', params);
  return {} as IRespSend;
}