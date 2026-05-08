import { ILogObj, Logger } from "tslog";
import { appendFileSync } from "fs";
import Utils from "./Utils";

function logToTransport(logObject: ILogObj): void {
  try {
    const logString = Utils.jsonStringify(logObject) + "\n";
    // Only write to file - let tslog handle console pretty printing
    appendFileSync("logs/payjoin.log", logString);
  } catch (error) {
    console.error("Failed to write log:", error);
  }
}

// Use default tslog configuration for pretty console output
const originalLogger = new Logger();

const logMethods = ['silly', 'trace', 'debug', 'info', 'warn', 'error', 'fatal'];

const logger = new Proxy(originalLogger, {
  get(target, prop) {
    if (logMethods.includes(prop as string)) {
      return (...args: any[]) => {
        const processedArgs = args.map(arg => {
          if (arg === undefined) return;
          if (typeof arg === 'function') {
            return arg.name ? `${arg.name}()` : 'anonymous()';
          }
          return JSON.parse(Utils.jsonStringify(arg));
        });

        return (target as any)[prop](...processedArgs);
      };
    }

    return (target as any)[prop];
  }
});

logger.attachTransport(logToTransport);

export default logger;
