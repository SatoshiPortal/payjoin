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
      logger.info(runJob, `Previous interval is still running: ${replicaLockName}. Skipping this run.`);
      return;
    }

    try {
      await lock.acquire(replicaLockName, async () => {
        logger.info(runJob, "Lock acquired. Restoring sessions...");
        await restoreSendSessions(config);
        await restoreReceiveSessions(config);
        logger.info(runJob, "Sessions processed. Releasing lock");
      });
    } catch (e) {
      logger.error(runJob, "Failed to run job:", e);
    }
  };

  activeInterval = setInterval(() => runJob(config), interval * 1000);
  logger.info(startCron, `Started interval every ${interval} seconds`);
}