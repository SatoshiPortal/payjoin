import { Config } from '../config';
import logger from "../lib/Log2File";
import { restoreSendSessions } from "./send";
import { restoreReceiveSessions } from "./receive";
import { lock } from "../lib/globals";

const lockName = "sessions";
let activeInterval: NodeJS.Timeout | null = null;

export function startCron(config: Config) {
  if (activeInterval) {
    logger.info(startCron, "Stopping previous interval");
    clearInterval(activeInterval);
    activeInterval = null;
  }

  const interval = config.CRON_INTERVAL; // in seconds

  const runJob = async (config: Config) => {
    if (lock.isBusy(lockName)) {
      logger.info(runJob, "Previous interval is still running");
      return;
    }

    logger.info(runJob, "Starting interval");

    lock.acquire(lockName, async () => {
      logger.info(runJob, "Lock acquired. Restoring sessions...");

      try {
        await restoreSendSessions();
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