
import { IResponseError } from "../jsonrpc/IResponseMessage";
import { RawTx } from "./IRespDecodeRawTransaction";

export interface PsbtGlobalXpub {
  xpub: string;
  master_fingerprint: string;
  path: string
}

export interface PsbtProprietary {
  identifier: string;
  subtype: number;
  key: string;
  value: string;
}

export interface PsbtInput {
  non_witness_utxo?: any; // @todo define this property
  witness_utxo?: {
    amount: number;
    scriptPubKey: {
      asm: string;
      desc: string;
      hex: string;
      type: string;
      address?: string;
    };
  };
  partial_signatures?: {
    [pubkey: string]: string;
  };
  sighash?: string;
  redeem_script?: {
    asm: string;
    hex: string;
    type: string;
  };
  witness_script?: {
    asm: string;
    hex: string;
    type: string;
  };
  bip32_derivs?: {
    pubkey: string;
    master_fingerprint: string;
    path: string;
  }[];
  final_scriptSig?: {
    asm: string;
    hex: string;
  };
  final_scriptwitness?: string[];
  ripemd160_preimages?: {
    [hash: string]: string;
  };
  sha256_preimages?: {
    [hash: string]: string;
  };
  hash160_preimages?: {
    [hash: string]: string;
  };
  hash256_preimages?: {
    [hash: string]: string;
  };
  taproot_key_path_sig?: string;
  taproot_script_path_sigs?: {
    pubkey: string;
    leaf_hash: string;
    sig: string;
  }[];
  taproot_scripts?: {
    script: string;
    leaf_ver: number;
    control_blocks: string[];
  }[];
  taproot_bip32_derivs?: {
    pubkey: string;
    master_fingerprint: string;
    path: string;
    leaf_hashes: string[];
  }[];
  taproot_internal_key?: string;
  taproot_merkle_root?: string;
  unknown?: { [key: string]: string };
  proprietary?: PsbtProprietary[];
}

export interface PsbtOutput {
  redeem_script?: {
    asm: string;
    hex: string;
    type: string;
  };
  witness_script?: {
    asm: string;
    hex: string;
    type: string;
  };
  bip32_derivs?: {
    pubkey: string;
    master_fingerprint: string;
    path: string;
  }[];
  taproot_internal_key?: string;
  taproot_tree?: {
    depth: number;
    leaf_ver: number;
    script: string;
  }[];
  taproot_bip32_derivs?: {
    pubkey: string;
    master_fingerprint: string;
    path: string;
    leaf_hashes: string[];
  }[];
  unknown?: { [key: string]: string };
  proprietary?: PsbtProprietary[];
}

export default interface IRespDecodePsbt {
  result?: {
    tx: RawTx;
    global_xpubs?: PsbtGlobalXpub[];
    psbt_version?: number;
    proprietary?: PsbtProprietary[];
    unknown?: { [key: string]: string };
    inputs: PsbtInput[];
    outputs: PsbtOutput[];
    fee?: number;
  };
  error?: IResponseError<never>;
}