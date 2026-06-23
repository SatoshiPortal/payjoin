import { Config } from '../config';
import logger from "../lib/Log2File";
import { restoreSendSessions } from "./send";
import { restoreReceiveSessions } from "./receive";
import { lock } from "../lib/globals";
import Utils from '../lib/Utils';
import { isShuttingDown, trackTask } from '../lib/gracefulShutdownRefs';

const lockName = "sessions";
const CRON_JITTER_RATIO = 0.3; // add up to +30% random delay per tick so polling isn't a fixed-period beacon
let activeTimeout: NodeJS.Timeout | null = null;

export function startCron(config: Config) {
  if (isShuttingDown()) return;

  if (activeTimeout) {
    logger.info(startCron, "Stopping previous interval");
    clearTimeout(activeTimeout);
    activeTimeout = null;
  }

  const interval = config.CRON_INTERVAL; // in seconds
  const { replicaId } = Utils.replicaInfo();
  const replicaLockName = `${lockName}-${replicaId}`;

  const runJob = async (config: Config) => {
    if (isShuttingDown()) return;

    if (await lock.isBusy(replicaLockName)) {
      logger.info(runJob, `Previous interval is still running: ${replicaLockName}. Skipping this run.`);
      return;
    }

    await trackTask(`cron-sessions-${replicaId}`, async () => {
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
    });
  };

  const scheduleNext = () => {
    if (isShuttingDown()) return;
    const jitterMs = Math.floor(Math.random() * interval * 1000 * CRON_JITTER_RATIO);
    activeTimeout = setTimeout(async () => {
      await runJob(config);
      scheduleNext();
    }, interval * 1000 + jitterMs);
  };

  scheduleNext();
  logger.info(startCron, `Started interval every ${interval}s (+up to ${Math.round(interval * CRON_JITTER_RATIO)}s jitter)`);
}

export function stopCron() {
  if (activeTimeout) {
    clearTimeout(activeTimeout);
    activeTimeout = null;
  }
}