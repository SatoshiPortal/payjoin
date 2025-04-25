import { ILogObj, Logger } from "tslog";
import { appendFileSync } from "fs";
import Utils from "./Utils";

function logToTransport(logObject: ILogObj): void {
  try {
    appendFileSync("logs/payjoin.log", Utils.jsonStringify(logObject) + "\n");
  } catch (error) {
    console.error("Failed to write log to file:", error);
  }
}

const logger = new Logger();
logger.attachTransport(logToTransport);

export default logger;
