import { LockManager } from "./Locker";
import { SyncCyphernodeClient } from "../lib/SyncCyphernodeClient";
import { CyphernodeClient } from "../lib/CyphernodeClient";
import { config } from "../config";

export const lock = new LockManager();
export const cnClient = new CyphernodeClient(config);
export const syncCnClient = new SyncCyphernodeClient(config);