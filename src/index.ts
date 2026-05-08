import { config } from './config';
import { registerApi } from './api';
import express, { Application } from 'express';
import { startCron } from './cron';
import logger from './lib/Log2File';
import { uniffiInitAsync } from 'payjoin';
import { setupGracefulShutdown } from './lib/gracefulShutdown';
import { setGracefulShutdownRefs } from './lib/gracefulShutdownRefs';

(async () => {
  logger.info('Starting....');

  await uniffiInitAsync();

  const app: Application = express();
  const port = config.URL_PORT;

  registerApi(app);

  const server = app.listen(port, () => {
    logger.info(`Server is running on http://localhost:${port}`);
  });

  const { isShuttingDown, trackTask } = setupGracefulShutdown(server, logger);
  setGracefulShutdownRefs(isShuttingDown, trackTask);

  startCron(config);
})();