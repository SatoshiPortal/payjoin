import { config } from './config';
import { registerApi } from './api';
import express, { Application } from 'express';
import { startCron } from './cron';

console.log('Starting....');

const app: Application = express();
const port = config.URL_PORT;

registerApi(app);

app.listen(port, () => {
  console.log(`Server is running on http://localhost:${port}`);
});

startCron();