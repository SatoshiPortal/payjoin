import { ILogObj, Logger } from "tslog";
import { appendFileSync, mkdirSync } from "fs";
import { dirname } from "path";
import Utils from "./Utils";

const REDACTED = "[REDACTED]";

function redactString(value: string): string {
  return value.replace(/(\btoken=)[^&#\s]*/gi, `$1${REDACTED}`);
}

function sensitiveKey(key: string): boolean {
  const normalized = key.toLowerCase();
  return normalized === "authorization" || normalized.endsWith("token");
}

/** Return a log-safe copy while preserving useful diagnostic structure. */
export function redactForLogging(value: unknown): unknown {
  if (typeof value === "string") return redactString(value);
  if (Array.isArray(value)) return value.map(redactForLogging);
  if (value instanceof Date || value instanceof Error || value === null || typeof value !== "object") {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      key,
      sensitiveKey(key) ? REDACTED : redactForLogging(entry),
    ]),
  );
}

const replicaNumber = process.env.REPLICA_NUMBER;
const logFileName = replicaNumber ? `logs/payjoin-${replicaNumber}.log` : "logs/payjoin.log";

function logToTransport(logObject: ILogObj): void {
  const meta = logObject._meta as {
    date: Date;
    logLevelName: string;
    path: { filePathWithLine: string };
  };

  const timestamp = new Date(meta.date).toISOString().replace("T", " ").replace("Z", "");
  const level = meta.logLevelName;
  const path = meta.path.filePathWithLine;

  const args: string[] = [];
  let i = 0;
  while (logObject[i.toString()] !== undefined) {
    const arg = logObject[i.toString()];
    if (typeof arg === "string") {
      args.push(arg);
    } else {
      args.push(Utils.jsonStringify(arg, true));
    }
    i++;
  }

  const message = args.join(" ");
  const logLine = `${timestamp}\t${level}\t${path}\t${message}\n`;

  try {
    mkdirSync(dirname(logFileName), { recursive: true });
    appendFileSync(logFileName, logLine);
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
          return JSON.parse(Utils.jsonStringify(redactForLogging(arg)));
        });

        return (target as any)[prop](...processedArgs);
      };
    }

    return (target as any)[prop];
  }
});

logger.attachTransport(logToTransport);

export default logger;
