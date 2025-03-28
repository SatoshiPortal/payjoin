import axios, { AxiosError, AxiosRequestConfig } from "axios";
import https from "https";
import { Config } from "../config";
import logger from "./Log2File";
import IResp from "../types/jsonrpc/IResp";
import { ErrorCodes, IResponseError } from "../types/jsonrpc/IResponseMessage";
import { isStubMode } from "./StubMode";
import { coinfuserClientStub } from "../stubs/CoinfuserClient";
import { IReqGetNewAddress, IRespGetNewAddress } from "../types/coinfuser/address";
import {
  IReqAddPayment,
  IReqCancelPayment,
  IReqGetPayment,
  IReqListPayments,
  IRespAddPayment,
  IRespCancelPayment,
  IRespGetPayment,
  IRespListPayments,
} from "../types/coinfuser/payment";
import { IRespProcessTransaction } from "../types/coinfuser/transaction";
import IRespGetBalance from "../types/cyphernode/IRespGetBalance";
import Utils from "./Utils";

class CoinfuserClient {
  private baseURL: string;
  private auth: string;

  constructor(config: Config) {
    this.baseURL = config.COINFUSER_URL;
    this.auth = config.COINFUSER_AUTH;
  }

  configure(config: Config): void {
    this.baseURL = config.COINFUSER_URL;
    this.auth = config.COINFUSER_AUTH;
  }

  async _post(
    url: string,
    postData: unknown,
    addedOptions?: unknown,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ): Promise<any> {
    logger.info("CoinfuserClient._post:", this.baseURL, url, postData, addedOptions);

    // Stub mode
    if (isStubMode()) return coinfuserClientStub(postData);

    let configs: AxiosRequestConfig = {
      url: url,
      method: "post",
      baseURL: this.baseURL,
      timeout: 60000,
      headers: {
        "Content-Type": "application/json",
        Authorization: "Basic " + Buffer.from(this.auth).toString("base64"),
      },
      data: postData,
      httpsAgent: new https.Agent({
        rejectUnauthorized: false,
      }),
    };
    if (addedOptions) {
      configs = Object.assign(configs, addedOptions);
    }

    try {
      const response = await axios.request(configs);
      logger.debug("CoinfuserClient._post :: response.data:", response.data);

      return { status: response.status, data: response.data };
    } catch (err) {
      if (axios.isAxiosError(err)) {
        const error: AxiosError = err;

        if (error.response) {
          // The request was made and the server responded with a status code
          // that falls out of the range of 2xx
          logger.info("CoinfuserClient._post :: error.response.data:", error.response.data);
          logger.info("CoinfuserClient._post :: error.response.status:", error.response.status);
          logger.info("CoinfuserClient._post :: error.response.headers:", error.response.headers);

          return { status: error.response.status, data: error.response.data };
        } else if (error.request) {
          // The request was made but no response was received
          // `error.request` is an instance of XMLHttpRequest in the browser and an instance of
          // http.ClientRequest in node.js
          logger.info("CoinfuserClient._post :: error.message:", error.message);

          return { status: -1, data: error.message };
        } else {
          // Something happened in setting up the request that triggered an Error
          logger.info("CoinfuserClient._post :: Error:", error.message);

          return { status: -2, data: error.message };
        }
      } else {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return { status: -2, data: (err as any).message };
      }
    }
  }

  async handleResponse(response: any): Promise<IResp> {
    let result: IResp;
    if (response.status >= 200 && response.status < 400) {
      result = { result: response.data.result ? response.data.result : response.data };
    } else {
      logger.error("CoinfuserClient.handleResponse :: error:", response.data);

      result = {
        error: {
          code: response.data.error?.code || ErrorCodes.InternalError,
          message: response.data.error?.message || response.data.message,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as IResponseError<any>,
      };
    }
    return result;
  }

  formatData(method: string, params?: { [key: string]: string | number }) {
    return { jsonrpc: "2.0", id: 0, method, params: params ? Utils.sanitizeResponse(params) : {} };
  }

  // @todo does the response type need to be wrapped in a JSONRPC response?
  async getNewAddress(params?: IReqGetNewAddress): Promise<IRespGetNewAddress> {
    logger.info("CoinfuserClient.getNewAddress", params);

    const data = this.formatData("getNewAddress", params as any);

    const response = await this._post("/jsonrpc", data);

    return this.handleResponse(response) as Promise<IRespGetNewAddress>;
  }

  async addPayment(params: IReqAddPayment): Promise<IRespAddPayment> {
    logger.info("CoinfuserClient.addPayment", params);

    const data = this.formatData("addPayment", params as any);

    const response = await this._post("/jsonrpc", data);

    return this.handleResponse(response) as Promise<IRespAddPayment>;
  }

  async getPayment(params: IReqGetPayment): Promise<IRespGetPayment> {
    logger.info("CoinfuserClient.getPayment", params);

    const data = this.formatData("getPayment", params as any);

    const response = await this._post("/jsonrpc", data);

    return this.handleResponse(response) as Promise<IRespGetPayment>;
  }

  async cancelPayment(params: IReqCancelPayment): Promise<IRespCancelPayment> {
    logger.info("CoinfuserClient.cancelPayment", params);

    const data = this.formatData("cancelPayment", params as any);

    const response = await this._post("/jsonrpc", data);

    return this.handleResponse(response) as Promise<IRespCancelPayment>;
  }

  async listPayments(params: IReqListPayments): Promise<IRespListPayments> {
    logger.info("CoinfuserClient.listPayments", params);

    const data = this.formatData("listPayments", params as any);

    const response = await this._post("/jsonrpc", data);

    return this.handleResponse(response) as Promise<IRespListPayments>;
  }

  async processTransaction(): Promise<IRespProcessTransaction> {
    logger.info("CoinfuserClient.processTransaction");

    const data = this.formatData("processTransaction");

    const response = await this._post("/jsonrpc", data);

    return this.handleResponse(response) as Promise<IRespProcessTransaction>;
  }

  async processPremix(): Promise<IRespProcessTransaction> {
    logger.info("CoinfuserClient.processPremix");

    const data = this.formatData("processPremix");

    const response = await this._post("/jsonrpc", data);

    return this.handleResponse(response) as Promise<IRespProcessTransaction>;
  }

  async getBalance(): Promise<IRespGetBalance> {
    logger.info("CoinfuserClient.getBalance");

    const data = this.formatData("getBalance");

    const response = await this._post("/jsonrpc", data);

    return this.handleResponse(response) as Promise<IRespGetBalance>;
  }
}

export { CoinfuserClient };
