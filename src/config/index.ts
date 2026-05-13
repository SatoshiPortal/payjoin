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
  PAYJOIN_DIRECTORY: string; // the directory server where the payjoin data is stored
  PAYJOIN_RECEIVE_EXPIRY: bigint; // the number of seconds before a payjoin request expires
  OHTTP_RELAYS: string[]; // ordered list of ohttp relay URLs to try in sequence
  OHTTP_RELAY_TIMEOUT_MS: number; // per-relay timeout in milliseconds when attempting fallback
  OUTPUT_SUBSTITUTION_ENABLED: boolean; // when false, receiver never substitutes its output (keeps original BIP21 address on-chain)
  MAX_PAYJOIN_FEE_RATE: number; // sat/vbyte — reject payjoin proposals whose fee rate exceeds this ceiling
}

export let config: Config = {
  BASE_DIR: process.env.BASE_DIR || "/payjoin",
  URL_SERVER: process.env.URL_SERVER || "http://payjoin",
  URL_PORT: Number(process.env.URL_PORT  || 8000),
  CN_URL: process.env.CN_URL || "https://gatekeeper:2009/v0",
  CN_API_ID: process.env.CN_API_ID || "",
  CN_API_KEY: process.env.CN_API_KEY || "",
  CRON_INTERVAL: Number(process.env.CRON_INTERVAL  || 30),
  SEND_WALLET: process.env.SEND_WALLET || "01",
  RECEIVE_WALLET: process.env.RECEIVE_WALLET || "01",
  PAYJOIN_DIRECTORY: process.env.PAYJOIN_DIRECTORY || "https://payjo.in",
  PAYJOIN_RECEIVE_EXPIRY: BigInt(process.env.PAYJOIN_RECEIVE_EXPIRY  || 300), // 5 minutes - to be inline roughly with the order expiry
  OHTTP_RELAYS: process.env.OHTTP_RELAYS ? process.env.OHTTP_RELAYS.split(',').map(s => s.trim()) : ["https://ohttp.cakewallet.com", "https://pj.benalleng.com", "https://pj.bobspacebkk.com"],
  OHTTP_RELAY_TIMEOUT_MS: Number(process.env.OHTTP_RELAY_TIMEOUT_MS || 10000),
  OUTPUT_SUBSTITUTION_ENABLED: process.env.OUTPUT_SUBSTITUTION_ENABLED?.toLowerCase() === "true",
  MAX_PAYJOIN_FEE_RATE: Number(process.env.MAX_PAYJOIN_FEE_RATE || 500), // 500 sat/vbyte default
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