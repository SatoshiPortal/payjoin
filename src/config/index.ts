import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';

export interface Config {
  BASE_DIR: string;
  URL_SERVER: string;
  URL_PORT: number;
  CN_URL: string;
  CN_API_ID: string;
  CN_API_KEY: string;
  CRON_INTERVAL: number; // the number of seconds between polling the ohttp relay
  SEND_WALLET: string; // the wallet to use for sending from (e.g. "01", "02", etc)
  RECEIVE_WALLET: string; // the wallet to use for receiving addresses to (e.g. "01", "02", etc)
  OWNED_WALLETS: string[]; // wallet indices a caller-supplied receive address must belong to (e.g. ["02", "01"])
  PAYJOIN_DIRECTORY: string; // the directory server where the payjoin data is stored
  PAYJOIN_RECEIVE_EXPIRY: bigint; // the number of seconds before a payjoin request expires
  OHTTP_RELAYS: string[]; // ordered list of ohttp relay URLs to try in sequence
  OHTTP_RELAY_TIMEOUT_MS: number; // per-relay timeout in milliseconds for quick requests (key fetch, proposal post)
  OHTTP_LONGPOLL_TIMEOUT_MS: number; // timeout for directory long-poll requests; should exceed the directory's ~30s long-poll window
  OUTPUT_SUBSTITUTION_ENABLED: boolean; // when false, receiver never substitutes its output (keeps original BIP21 address on-chain)
  MAX_PAYJOIN_FEE_RATE: number; // sat/vbyte — reject payjoin proposals whose fee rate exceeds this ceiling
  RESERVATION_RELEASE_GRACE: number; // seconds past expiryTs before an unbroadcast send lock is force-released
}

const sendWallet = process.env.SEND_WALLET || "01";
const receiveWallet = process.env.RECEIVE_WALLET || "01";

/**
 * Captured at import rather than read live inside `reloadConfig`, because that
 * function writes every parsed config.env key back into process.env — reading
 * it live would resurrect an OWNED_WALLETS value the operator has since deleted
 * from the file. This is the compose `environment:` case: a value supplied that
 * way is honoured at boot, so it has to survive a reload too.
 */
const bootOwnedWallets = process.env.OWNED_WALLETS;

/**
 * Wallets whose addresses `receive` will accept when the caller supplies one.
 * RECEIVE_WALLET goes first so the common case short-circuits on the first
 * getaddressinfo call. Cyphernode has no wallet-enumeration endpoint, so this
 * set has to be known out of band.
 */
export function defaultOwnedWallets(receive: string, send: string): string[] {
  return [...new Set([receive, send])];
}

function parseWalletList(value: string): string[] {
  return [...new Set(value.split(',').map((s) => s.trim()).filter(Boolean))];
}

export let config: Config = {
  BASE_DIR: process.env.BASE_DIR || "/payjoin",
  URL_SERVER: process.env.URL_SERVER || "http://payjoin",
  URL_PORT: Number(process.env.URL_PORT  || 8000),
  CN_URL: process.env.CN_URL || "https://gatekeeper:2009/v0",
  CN_API_ID: process.env.CN_API_ID || "",
  CN_API_KEY: process.env.CN_API_KEY || "",
  CRON_INTERVAL: Number(process.env.CRON_INTERVAL  || 30),
  SEND_WALLET: sendWallet,
  RECEIVE_WALLET: receiveWallet,
  OWNED_WALLETS: bootOwnedWallets
    ? parseWalletList(bootOwnedWallets)
    : defaultOwnedWallets(receiveWallet, sendWallet),
  PAYJOIN_DIRECTORY: process.env.PAYJOIN_DIRECTORY || "https://payjo.in",
  PAYJOIN_RECEIVE_EXPIRY: BigInt(process.env.PAYJOIN_RECEIVE_EXPIRY  || 300), // 5 minutes - to be inline roughly with the order expiry
  OHTTP_RELAYS: process.env.OHTTP_RELAYS ? process.env.OHTTP_RELAYS.split(',').map(s => s.trim()) : ["https://ohttp.cakewallet.com", "https://pj.bobspacebkk.com", "https://ohttp.achow101.com"],
  OHTTP_RELAY_TIMEOUT_MS: Number(process.env.OHTTP_RELAY_TIMEOUT_MS || 10000),
  OHTTP_LONGPOLL_TIMEOUT_MS: Number(process.env.OHTTP_LONGPOLL_TIMEOUT_MS || 35000),
  OUTPUT_SUBSTITUTION_ENABLED: process.env.OUTPUT_SUBSTITUTION_ENABLED?.toLowerCase() === "true",
  MAX_PAYJOIN_FEE_RATE: Number(process.env.MAX_PAYJOIN_FEE_RATE || 500), // 500 sat/vbyte default
  RESERVATION_RELEASE_GRACE: Number(process.env.RESERVATION_RELEASE_GRACE || 1800), // 30m default for unbroadcast send locks; posted receive reservations require a confirmed outcome
};

export function reloadConfig(): Config {
  const configPath = path.resolve(process.env.BASE_DIR || '/payjoin', 'data/config.env');
  const envConfig = dotenv.parse(fs.readFileSync(configPath));

  for (const key in envConfig) {
    process.env[key] = envConfig[key];
    if (key in config) {
      const currentValue = config[key];
      config[key] = Array.isArray(currentValue)
        ? envConfig[key].split(',').map((s: string) => s.trim())
        : castConfigValue(typeof currentValue, envConfig[key]);
    }
  }

  // OWNED_WALLETS derives from the wallet keys when it isn't pinned explicitly,
  // so recompute it here — the loop above only touches keys present in
  // config.env, which would otherwise leave a stale set behind after a
  // RECEIVE_WALLET/SEND_WALLET change. Re-parsing the explicit value also dedupes
  // and drops blanks, which the generic array branch does not. config.env wins
  // over the boot environment, which in turn wins over the derived default —
  // matching the precedence used at import.
  const ownedWallets = envConfig.OWNED_WALLETS ?? bootOwnedWallets;
  config.OWNED_WALLETS = ownedWallets
    ? parseWalletList(ownedWallets)
    : defaultOwnedWallets(config.RECEIVE_WALLET, config.SEND_WALLET);

  return config;
}

function castConfigValue(type: string, value: string): any {
  switch (type) {
    case "number":
      return Number(value);
    case "bigint":
      return BigInt(value);
    case "boolean":
      return value.toLowerCase() === "true";
    default:
      return value;
  }
}
