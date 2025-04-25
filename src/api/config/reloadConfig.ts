import { JSONRPCErrorCode, JSONRPCErrorException } from "json-rpc-2.0";
import { reloadConfig as execReloadConfig, Config } from "../../config";
import logger from "../../lib/Log2File";
import { startCron } from "../../cron";
import { cnClient, syncCnClient } from "../../lib/globals";

export async function reloadConfig(): Promise<Config> {
  logger.info(reloadConfig, 'reloading Config');
  try {

    const config = execReloadConfig();
    cnClient.configureCyphernode(config);
    syncCnClient.configureCyphernode(config);
    startCron(config);

    return config;
  } catch (e) {
    logger.error(reloadConfig, "Failed to reload config:", e);
    throw new JSONRPCErrorException('Failed to reload config', JSONRPCErrorCode.InternalError);
  }
}
