import { IResponseError } from "../jsonrpc/IResponseMessage";

export default interface IRespGetAddressInfo {
  result?: {
    address: string;
    scriptPubKey: string;
    ismine: boolean;
    solvable: boolean;
    desc?: string;
    parent_desc?: string;
    iswatchonly: boolean;
    isscript: boolean;
    iswitness: boolean;
    witness_version?: number;
    witness_program?: string;
    pubkey?: string;
    ischange?: boolean;
    timestamp?: number;
    hdkeypath?: string;
    hdseedid?: string;
    hdmasterfingerprint?: string;
    labels?: string[];
  };
  error?: IResponseError<never>;
}