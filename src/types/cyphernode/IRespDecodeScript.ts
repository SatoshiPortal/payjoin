import { IResponseError } from "../jsonrpc/IResponseMessage";

export default interface IRespDecodeScript {
  result?: {
    asm: string;
    desc: string;
    address?: string;
    type: string;
    p2sh?: string;
    segwit?: {
      asm: string;
      hex?: string; // optional, only present if the script is a P2SH
      type: string; // e
      address?: string; // optional, only present if the script is a P2SH
      desc: string; // optional, only present if the script is a P2SH
      "p2sh_segwit"?: string; // optional, only present if the script is a P2SH
    }
  };
  error?: IResponseError<never>;
}