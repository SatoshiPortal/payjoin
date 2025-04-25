import { CyphernodeClient } from "./CyphernodeClient";
import { Config } from "../config";
import * as syncRequest from "sync-request";
import fs from "fs";
import logger from "./Log2File";
import IRespTestMempoolAccept from "../types/cyphernode/IRespTestMempoolAccept";
import { IReqTestMempoolAccept } from "../types/cyphernode/IReqTestMempoolAccept";
import IRespProcessPsbt from "../types/cyphernode/IRespProcessPsbt";
import { IReqProcessPsbt } from "../types/cyphernode/IReqProcessPsbt";
import { IReqGetAddressInfo } from "../types/cyphernode/IReqGetAddressInfo";
import IRespGetAddressInfo from "../types/cyphernode/IRespGetAddressInfo";
import IRespDecodeScript from "../types/cyphernode/IRespDecodeScript";

/**
 * NOTE: sync-request has an issue where it ignores rejectUnauthorized: false
 * so ENV NODE_TLS_REJECT_UNAUTHORIZED=0 must be set to ignore self-signed cert errors
 * 
 * This is not ideal but there doesn't seem to be a better way to do this. Perhaps can patch the package?!
 */
export class SyncCyphernodeClient extends CyphernodeClient {
  constructor(config: Config) {
    super(config);
  }

  // Override _post with synchronous version
  _post(
    url: string,
    postdata: unknown,
    addedOptions?: unknown,
  ): any {
    logger.info("SyncCyphernodeClient._post:", this.baseURL, url, postdata, addedOptions);

    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

    try {
      let options: any = {
        json: postdata,
        headers: {
          Authorization: "Bearer " + this._generateToken(),
        },
        timeout: 60000,
      };

      const ca = fs.readFileSync(this.caFile);
      options.agentOptions = {
        ca,
        rejectUnauthorized: false,
      };

      if (addedOptions) {
        options = { ...options, ...addedOptions };
      }

      const fullUrl = `${this.baseURL}${url}`;
      logger.debug("SyncCyphernodeClient._post making request to:", fullUrl);
      
      const response = syncRequest.default("POST", fullUrl, options);
      
      const body = response.getBody('utf8');
      const data = JSON.parse(body);
      
      logger.debug("SyncCyphernodeClient._post received:", data);
      
      return { 
        status: response.statusCode, 
        data: data 
      };
    } catch (err: any) {
      logger.error("SyncCyphernodeClient._post error:", err);
      
      if (err.name === "RequestError" || err.name === "HTTPError") {
        if (err.statusCode) {
          return { 
            status: err.statusCode, 
            data: err.body ? JSON.parse(err.body.toString()) : err.message 
          };
        }
        
        return { status: -1, data: err.message };
      }
      
      return { status: -2, data: err.message };
    }
  }

  // Override _get with synchronous version
  _get(url: string, addedOptions?: unknown): any {
    logger.info("SyncCyphernodeClient._get:", url, addedOptions);

    try {
      let options: any = {
        headers: {
          Authorization: "Bearer " + this._generateToken(),
        },
        timeout: 30000,
      };


      options.agentOptions = {
        ca: fs.readFileSync(this.caFile),
        rejectUnauthorized: false,
      };

      if (addedOptions) {
        options = { ...options, ...addedOptions };
      }

      const fullUrl = `${this.baseURL}${url}`;
      logger.debug("SyncCyphernodeClient._get making request to:", fullUrl);
      
      const response = syncRequest.default("GET", fullUrl, options);
      
      const body = response.getBody('utf8');
      const data = JSON.parse(body);
      
      logger.debug("SyncCyphernodeClient._get received:", data);
      
      return { 
        status: response.statusCode, 
        data: data 
      };
    } catch (err: any) {
      logger.error("SyncCyphernodeClient._get error:", err);
      
      if (err.name === "RequestError" || err.name === "HTTPError") {
        if (err.statusCode) {
          return { 
            status: err.statusCode, 
            data: err.body ? JSON.parse(err.body.toString()) : err.message 
          };
        }

        return { status: -1, data: err.message };
      }
      
      return { status: -2, data: err.message };
    }
  }

  syncTestMempoolAccept(params: IReqTestMempoolAccept): IRespTestMempoolAccept {
    logger.info("SyncCyphernodeClient.testMempoolAccept:", params);

    const response = this._post("/testmempoolaccept", params);

    return this.handleResponse(response) as IRespTestMempoolAccept;
  }

  syncProcessPsbt(params: IReqProcessPsbt): IRespProcessPsbt {
    logger.info("SyncCyphernodeClient.processPsbt:", params);

    const response = this._post("/processpsbt", params);

    return this.handleResponse(response) as IRespProcessPsbt;
  }

  syncGetAddressInfo(params: IReqGetAddressInfo): IRespGetAddressInfo {
    logger.info("SyncCyphernodeClient.getAddressInfo:", params);

    const response = this._post("/getaddressinfo", params);

    return this.handleResponse(response) as IRespGetAddressInfo;
  }

  syncDecodeScript(scriptPubKey: string): IRespDecodeScript {
    logger.info("SyncCyphernodeClient.decodeScript:", scriptPubKey);

    const response = this._get(`/decodescript/${scriptPubKey}`);

    return this.handleResponse(response) as IRespDecodeScript;
  }
}