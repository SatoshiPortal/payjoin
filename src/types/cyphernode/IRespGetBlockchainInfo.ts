import { IResponseError } from "../jsonrpc/IResponseMessage";

/*
chain: 'test',
        blocks: 2861101,
        headers: 2861101,
        bestblockhash: '000000000b4da63a72953ac4978f532b8c516a955c5ec909035e8d47faebd96c',
        difficulty: 1,
        time: 1719484460,
        mediantime: 1719482374,
        verificationprogress: 1,
        initialblockdownload: false,
        chainwork: '000000000000000000000000000000000000000000000e43b8a2c968c42c13da',
        size_on_disk: 70957115634,
        pruned: false,
        softforks: {
          bip34: [Object],
          bip66: [Object],
          bip65: [Object],
          csv: [Object],
          segwit: [Object],
          taproot: [Object]
        },
        warnings: 'Unknown new rules activated (versionbit 28)'*/

export default interface IRespGetBlockchainInfo {
  result?: {
    chain: string;
    blocks: number;
    headers: number;
    bestblockhash: string;
    difficulty: 1;
    time: number;
    mediantime: number;
    verificationprogress: number;
    initialblockdownload: boolean;
    chainwork: string;
    size_on_disk: number;
    pruned: boolean;
    softforks: {
      [key: string]: any;
    };
    warnings: string;
  };
  error?: IResponseError<never>;
}
