import { Config } from '../config';
import logger from "../lib/Log2File";
import { restoreSendSessions } from "./send";
import { restoreReceiveSessions } from "./receive";
import { lock } from "../lib/globals";
import Utils from '../lib/Utils';

const lockName = "sessions";
let activeInterval: NodeJS.Timeout | null = null;

export function startCron(config: Config) {
  if (activeInterval) {
    logger.info(startCron, "Stopping previous interval");
    clearInterval(activeInterval);
    activeInterval = null;
  }

  const interval = config.CRON_INTERVAL; // in seconds
  const { replicaId } = Utils.replicaInfo();
  const replicaLockName = `${lockName}-${replicaId}`;

  const runJob = async (config: Config) => {
    if (await lock.isBusy(replicaLockName)) {
      logger.info(runJob, "Previous interval is still running");
      return;
    }

    lock.acquire(replicaLockName, async () => {
      logger.info(runJob, "Lock acquired. Restoring sessions...");

      try {
        await restoreSendSessions(config);
        await restoreReceiveSessions(config);
      } catch (e) {
        logger.error(runJob, "Failed to restore sessions:", e);
      }

      logger.info(runJob, "Sessions processed. Releasing lock");
    });
  };

  activeInterval = setInterval(() => runJob(config), interval * 1000);
  logger.info(startCron, `Started interval every ${interval} seconds`);
}