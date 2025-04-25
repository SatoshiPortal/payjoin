import { addJsonRpcMethod } from "..";
import { reloadConfig } from "./reloadConfig";

export function registerConfigApi(): void {
  addJsonRpcMethod('reloadConfig', reloadConfig);
}