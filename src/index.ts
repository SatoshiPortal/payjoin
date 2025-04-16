import { config } from './config';
import { registerApi } from './api';
import express, { Application } from 'express';
import { startCron } from './cron';
import logger from './lib/Log2File';

logger.info('Starting....');

const app: Application = express();
const port = config.URL_PORT;

registerApi(app);

app.listen(port, () => {
  logger.info(`Server is running on http://localhost:${port}`);
});

startCron(config);