import { SyncCyphernodeClient } from "../lib/SyncCyphernodeClient";
import AsyncLock from "async-lock";
import { CyphernodeClient } from "../lib/CyphernodeClient";
import { config } from "../config";

export const lock = new AsyncLock();
export const cnClient = new CyphernodeClient(config);
export const syncCnClient = new SyncCyphernodeClient(config);