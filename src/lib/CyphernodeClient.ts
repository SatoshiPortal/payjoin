import logger from "./Log2File";
import crypto from "crypto";
import axios, { AxiosError, AxiosRequestConfig, AxiosResponse } from "axios";
import https from "https";
import path from "path";
import fs from "fs";
import { Config } from "../config";
import IResp from "../types/jsonrpc/IResp";
import { IResponseError, ErrorCodes } from "../types/jsonrpc/IResponseMessage";
import IRespGetBatchDetails from "../types/cyphernode/IRespGetBatchDetails";
import IRespAddToBatch from "../types/cyphernode/IRespAddToBatch";
import IReqBatchSpend from "../types/cyphernode/IReqBatchSpend";
import IReqGetBatchDetails from "../types/cyphernode/IReqGetBatchDetails";
import IRespBatchSpend from "../types/cyphernode/IRespBatchSpend";
import IReqAddToBatch from "../types/cyphernode/IReqAddToBatch";
import IReqSpend from "../types/cyphernode/IReqSpend";
import IRespSpend from "../types/cyphernode/IRespSpend";
import IReqLnPay from "../types/cyphernode/IReqLnPay";
import IRespLnPay from "../types/cyphernode/IRespLnPay";
import IReqWasabiGetNewAddress from "../types/cyphernode/IReqWasabiGetNewAddress";
import IRespWasabiGetNewAddress from "../types/cyphernode/IRespWasabiGetNewAddress";
import IRespWasabiGetBalances from "../types/cyphernode/IRespWasabiGetBalances";
import IReqWasabiSpend from "../types/cyphernode/IReqWasabiSpend";
import IRespWasabiSpend from "../types/cyphernode/IRespWasabiSpend";
import IReqWasabiPayInCoinJoin from "../types/cyphernode/IReqWasabiPayInCoinJoin";
import IRespWasabiPayInCoinJoin from "../types/cyphernode/IRespWasabiPayInCoinJoin";
import IRespWasabiGetUnspentCoins from "../types/cyphernode/IRespWasabiGetUnspentCoins";
import IReqWatch from "../types/cyphernode/IReqWatch";
import IRespWatch from "../types/cyphernode/IRespWatch";
import IReqUnwatch from "../types/cyphernode/IReqUnwatch";
import IRespUnwatch from "../types/cyphernode/IRespUnwatch";
import IReqWatchTxid from "../types/cyphernode/IReqWatchTxid";
import IRespWatchTxid from "../types/cyphernode/IRespWatchTxid";
import IReqUnwatchTxid from "../types/cyphernode/IReqUnwatchTxid";
import IRespUnwatchTxid from "../types/cyphernode/IRespUnwatchTxid";
import IReqGetNewAddress from "../types/cyphernode/IReqGetNewAddress";
import IRespGetNewAddress from "../types/cyphernode/IRespGetNewAddress";
import IRespGetBalance from "../types/cyphernode/IRespGetBalance";
import IReqLnCreateInvoice from "../types/cyphernode/IReqLnCreateInvoice";
import IRespLnCreateInvoice from "../types/cyphernode/IRespLnCreateInvoice";
import IReqElementsSpend from "../types/cyphernode/IReqElementsSpend";
import IRespElementsSpend from "../types/cyphernode/IRespElementsSpend";
import IRespGetTransaction from "../types/cyphernode/IRespGetTransaction";
import IRespWasabiListPayInCoinJoin from "../types/cyphernode/IRespWasabiListPayInCoinJoin";
import IRespWasabiCancelPayInCoinJoin from "../types/cyphernode/IRespWasabiCancelPayInCoinJoin";
import IReqWasabiCancelPayInCoinJoin from "../types/cyphernode/IReqWasabiCancelPayInCoinJoin";
import IRespGetBlockchainInfo from "../types/cyphernode/IRespGetBlockchainInfo";
import { IReqCreateRawTransaction } from "../types/cyphernode/IReqCreateRawTransaction";
import IRespCreateRawTransaction from "../types/cyphernode/IRespCreateRawTransaction";
import { IReqFundRawTransaction } from "../types/cyphernode/IReqFundRawTransaction";
import IRespFundRawTransaction from "../types/cyphernode/IRespFundRawTransaction";
import { IReqSignRawTransaction } from "../types/cyphernode/IReqSignRawTransaction";
import IRespSignRawTransaction from "../types/cyphernode/IRespSignRawTransaction";
import { IReqListUnspent } from "../types/cyphernode/IReqListUnspent";
import IRespListUnspent from "../types/cyphernode/IRespListUnspent";
import { IReqSendMany } from "../types/cyphernode/IReqSendMany";
import IRespSendMany from "../types/cyphernode/IRespSendMany";
import { IReqDecodeRawTransaction } from "../types/cyphernode/IReqDecodeRawTransaction";
import IRespDecodeRawTransaction from "../types/cyphernode/IRespDecodeRawTransaction";
import { IReqSendRawTransaction } from "../types/cyphernode/IReqSendRawTransaction";
import IRespSendRawTransaction from "../types/cyphernode/IRespSendRawTransaction";
import { IReqGetBalance } from "../types/cyphernode/IReqGetBalance";
import { IReqLockUnspent } from "../types/cyphernode/IReqLockUnspent";
import IRespLockUnspent from "../types/cyphernode/IRespLockUnspent";
import { IReqListLockUnspent } from "../types/cyphernode/IReqListLockUnspent";
import IRespListLockUnspent from "../types/cyphernode/IRespListLockUnspent";
import { IReqGetFeeRate } from "../types/cyphernode/IReqGetFeeRate";
import IRespGetFeeRate from "../types/cyphernode/IRespGetFeeRate";
import IRespValidateAddress from "../types/cyphernode/IRespValidateAddress";

class CyphernodeClient {
  private baseURL: string;
  private readonly h64: string = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9Cg==";
  private apiId: string;
  private apiKey: string;
  private caFile: string;

  constructor(config: Config) {
    this.baseURL = config.CN_URL;
    this.apiId = config.CN_API_ID;
    this.apiKey = config.CN_API_KEY;
    this.caFile = path.resolve(config.BASE_DIR, "cert.pem");
  }

  configureCyphernode(config: Config): void {
    this.baseURL = config.CN_URL;
    this.apiId = config.CN_API_ID;
    this.apiKey = config.CN_API_KEY;
    this.caFile = path.resolve(config.BASE_DIR, "cert.pem");
  }

  _generateToken(): string {
    logger.info("CyphernodeClient._generateToken");

    const current = Math.round(new Date().getTime() / 1000) + 10;
    const p = '{"id":"' + this.apiId + '","exp":' + current + "}";
    const p64 = Buffer.from(p).toString("base64");
    const msg = this.h64 + "." + p64;
    const s = crypto.createHmac("sha256", this.apiKey).update(msg).digest("hex");
    const token = msg + "." + s;

    logger.debug("CyphernodeClient._generateToken :: token=" + token);

    return token;
  }

  async _post(
    url: string,
    postdata: unknown,
    addedOptions?: unknown,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ): Promise<any> {
    logger.info("CyphernodeClient._post:", this.baseURL, url, postdata, addedOptions);

    let configs: AxiosRequestConfig = {
      url: url,
      method: "post",
      baseURL: this.baseURL,
      timeout: 60000,
      headers: {
        Authorization: "Bearer " + this._generateToken(),
      },
      data: postdata,
      httpsAgent: new https.Agent({
        ca: fs.readFileSync(this.caFile),
        rejectUnauthorized: false,
      }),
    };
    if (addedOptions) {
      configs = Object.assign(configs, addedOptions);
    }

    // logger.debug(
    //   "CyphernodeClient._post :: configs: %s",
    //   JSON.stringify(configs)
    // );

    try {
      const response = await axios.request(configs);
      //logger.debug("CyphernodeClient._post :: response.data:", response.data);

      return { status: response.status, data: response.data };
    } catch (err) {
      if (axios.isAxiosError(err)) {
        const error: AxiosError = err;

        if (error.response) {
          // The request was made and the server responded with a status code
          // that falls out of the range of 2xx
          // logger.info("CyphernodeClient._post :: error.response.data:", error.response.data);
          // logger.info("CyphernodeClient._post :: error.response.status:", error.response.status);
          // logger.info("CyphernodeClient._post :: error.response.headers:", error.response.headers);

          return { status: error.response.status, data: error.response.data };
        } else if (error.request) {
          // The request was made but no response was received
          // `error.request` is an instance of XMLHttpRequest in the browser and an instance of
          // http.ClientRequest in node.js
          logger.info("CyphernodeClient._post :: error.message:", error.message);

          return { status: -1, data: error.message };
        } else {
          // Something happened in setting up the request that triggered an Error
          logger.info("CyphernodeClient._post :: Error:", error.message);

          return { status: -2, data: error.message };
        }
      } else {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return { status: -2, data: (err as any).message };
      }
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async _get(url: string, addedOptions?: unknown): Promise<any> {
    logger.info("CyphernodeClient._get:", url, addedOptions);

    let configs: AxiosRequestConfig = {
      url: url,
      method: "get",
      baseURL: this.baseURL,
      timeout: 30000,
      headers: {
        Authorization: "Bearer " + this._generateToken(),
      },
      httpsAgent: new https.Agent({
        ca: fs.readFileSync(this.caFile),
        rejectUnauthorized: false,
      }),
    };
    if (addedOptions) {
      configs = Object.assign(configs, addedOptions);
    }

    try {
      const response = await axios.request(configs);
      //logger.debug("CyphernodeClient._get :: response.data:", response.data);

      return { status: response.status, data: response.data };
    } catch (err) {
      if (axios.isAxiosError(err)) {
        const error: AxiosError = err;

        if (error.response) {
          // The request was made and the server responded with a status code
          // that falls out of the range of 2xx
          logger.info("CyphernodeClient._get :: error.response.data:", error.response.data);
          logger.info("CyphernodeClient._get :: error.response.status:", error.response.status);
          logger.info("CyphernodeClient._get :: error.response.headers:", error.response.headers);

          return { status: error.response.status, data: error.response.data };
        } else if (error.request) {
          // The request was made but no response was received
          // `error.request` is an instance of XMLHttpRequest in the browser and an instance of
          // http.ClientRequest in node.js
          logger.info("CyphernodeClient._get :: error.message:", error.message);

          return { status: -1, data: error.message };
        } else {
          // Something happened in setting up the request that triggered an Error
          logger.info("CyphernodeClient._get :: Error:", error.message);

          return { status: -2, data: error.message };
        }
      } else {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return { status: -2, data: (err as any).message };
      }
    }
  }

  handleResponse(response: AxiosResponse): IResp {
    let result: IResp;
    if (response.status >= 200 && response.status < 400) {
      result = { result: response.data.result ? response.data.result : response.data };
    } else {
      result = {
        error: {
          code: response.data.error?.code || ErrorCodes.InternalError,
          message: response.data.error?.message || response.data.message || response.data,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as IResponseError<any>,
      };
    }
    return result;
  }

  async getblockchaininfo(): Promise<IRespGetBlockchainInfo> {
    // curl (GET) http://192.168.111.152:8000/getblockchaininfo

    logger.info("CyphernodeClient.getblockchaininfo");

    const response = await this._get("/getblockchaininfo");

    return this.handleResponse(response) as IRespGetBlockchainInfo;
  }

  async watch(watchProps: IReqWatch): Promise<IRespWatch> {
    // POST http://192.168.111.152:8080/watch
    // BODY {"address":"2N8DcqzfkYi8CkYzvNNS5amoq3SbAcQNXKp","unconfirmedCallbackURL":"192.168.111.233:1111/callback0conf","confirmedCallbackURL":"192.168.111.233:1111/callback1conf"}
    // BODY {"address":"2N8DcqzfkYi8CkYzvNNS5amoq3SbAcQNXKp","confirmedCallbackURL":"192.168.111.233:1111/callback1conf","eventMessage":"eyJib3VuY2VfYWRkcmVzcyI6IjJNdkEzeHIzOHIxNXRRZWhGblBKMVhBdXJDUFR2ZTZOamNGIiwibmJfY29uZiI6MH0K"}
    // BODY {"address":"2N8DcqzfkYi8CkYzvNNS5amoq3SbAcQNXKp","confirmedCallbackURL":"192.168.111.233:1111/callback1conf","eventMessage":"eyJib3VuY2VfYWRkcmVzcyI6IjJNdkEzeHIzOHIxNXRRZWhGblBKMVhBdXJDUFR2ZTZOamNGIiwibmJfY29uZiI6MH0K","label":"myLabel"}

    logger.info("CyphernodeClient.watch:", watchProps);

    const response = await this._post("/watch", watchProps);

    return this.handleResponse(response) as IRespWatch;
  }

  async unwatch(unwatchProps: IReqUnwatch): Promise<IRespUnwatch> {
    // curl (GET) 192.168.111.152:8080/unwatch/2N8DcqzfkYi8CkYzvNNS5amoq3SbAcQNXKp
    // or
    // POST http://192.168.111.152:8080/unwatch
    // BODY {"address":"2N8DcqzfkYi8CkYzvNNS5amoq3SbAcQNXKp","unconfirmedCallbackURL":"192.168.111.233:1111/callback0conf","confirmedCallbackURL":"192.168.111.233:1111/callback1conf"}
    // or
    // BODY {"id":3124}

    // args:
    // - address: string, required
    // - unconfirmedCallbackURL: string, optional
    // - confirmedCallbackURL: string, optional
    // or
    // - id: the id returned by the watch

    logger.info("CyphernodeClient.unwatch", unwatchProps);

    let response;
    if (typeof unwatchProps === "string") {
      response = await this._get(`/unwatch/${unwatchProps}`);
    } else {
      response = await this._post("/unwatch", unwatchProps);
    }

    return this.handleResponse(response) as IRespUnwatch;
  }

  async watchtxid(watchtxidProps: IReqWatchTxid): Promise<IRespWatchTxid> {
    // POST http://192.168.111.152:8080/watchtxid
    // BODY {"txid":"b081ca7724386f549cf0c16f71db6affeb52ff7a0d9b606fb2e5c43faffd3387","confirmedCallbackURL":"192.168.111.233:1111/callback1conf","xconfCallbackURL":"192.168.111.233:1111/callbackXconf","nbxconf":6}
    // curl -H "Content-Type: application/json" -d '{"txid":"b081ca7724386f549cf0c16f71db6affeb52ff7a0d9b606fb2e5c43faffd3387","confirmedCallbackURL":"192.168.111.233:1111/callback1conf","xconfCallbackURL":"192.168.111.233:1111/callbackXconf","nbxconf":6}' proxy:8888/watchtxid

    logger.info("CyphernodeClient.watchtxid", watchtxidProps);

    const response = await this._post("/watchtxid", watchtxidProps);

    return this.handleResponse(response) as IRespWatchTxid;
  }

  async unwatchtxid(unwatchTxidProps: IReqUnwatchTxid): Promise<IRespUnwatchTxid> {
    // POST http://192.168.111.152:8080/unwatchtxid
    // BODY {"txid":"b081ca7724386f549cf0c16f71db6affeb52ff7a0d9b606fb2e5c43faffd3387","unconfirmedCallbackURL":"192.168.111.233:1111/callback0conf","confirmedCallbackURL":"192.168.111.233:1111/callback1conf"}
    // or
    // BODY {"id":3124}

    // args:
    // - txid: string, required
    // - confirmedCallbackURL: string, optional
    // - xconfCallbackURL: string, optional
    // or
    // - id: the id returned by watchtxid

    logger.info("CyphernodeClient.unwatchtxid", unwatchTxidProps);

    const response = await this._post("/unwatchtxid", unwatchTxidProps);

    return this.handleResponse(response) as IRespUnwatchTxid;
  }

  async getbalance(params?: IReqGetBalance): Promise<IRespGetBalance> {
    // curl (GET) http://192.168.111.152:8080/getbalance

    logger.info("CyphernodeClient.getbalance", params);

    let uri = "/getbalance";
    if (params.wallet) {
      uri += `/${params.wallet}`;
    }
    const response = await this._get(uri);

    return this.handleResponse(response) as IRespGetBalance;
  }

  async getnewaddress(newAddressProps?: IReqGetNewAddress): Promise<IRespGetNewAddress> {
    // curl (GET) http://192.168.111.152:8080/getnewaddress
    // curl (GET) http://192.168.111.152:8080/getnewaddress/bech32
    //
    // or...
    // POST http://192.168.111.152:8080/getnewaddress
    // BODY {"addressType":"bech32","label":"myLabel"}
    // BODY {"label":"myLabel"}
    // BODY {"addressType":"p2sh-segwit"}
    // BODY {}

    logger.info("CyphernodeClient.getnewaddress", newAddressProps);

    let response;
    if (!newAddressProps) {
      response = await this._get("/getnewaddress");
    } else if (typeof newAddressProps === "string") {
      response = await this._get(`/getnewaddress/${newAddressProps}`);
    } else {
      response = await this._post("/getnewaddress", newAddressProps);
    }

    return this.handleResponse(response) as IRespGetNewAddress;
  }

  async elementsGetNewAddress(newAddressProps?: IReqGetNewAddress): Promise<IRespGetNewAddress> {
    // curl (GET) http://192.168.111.152:8080/elements_getnewaddress
    // curl (GET) http://192.168.111.152:8080/elements_getnewaddress/bech32
    //
    // or...
    // POST http://192.168.111.152:8080/elements_getnewaddress
    // BODY {"addressType":"bech32","label":"myLabel"}
    // BODY {"label":"myLabel"}
    // BODY {"addressType":"p2sh-segwit"}
    // BODY {}

    logger.info("CyphernodeClient.elementsGetNewAddress", newAddressProps);

    let response;
    if (!newAddressProps) {
      response = await this._get("/elements_getnewaddress");
    } else if (typeof newAddressProps === "string") {
      response = await this._get(`/elements_getnewaddress/${newAddressProps}`);
    } else {
      response = await this._post("/elements_getnewaddress", newAddressProps);
    }

    return this.handleResponse(response) as IRespGetNewAddress;
  }

  async addToBatch(batchRequestTO: IReqAddToBatch): Promise<IRespAddToBatch> {
    // POST http://192.168.111.152:8080/addtobatch

    // args:
    // - address, required, desination address
    // - amount, required, amount to send to the destination address
    // - batchId, optional, the id of the batch to which the output will be added, default batch if not supplied, overrides batchLabel
    // - batchLabel, optional, the label of the batch to which the output will be added, default batch if not supplied
    // - webhookUrl, optional, the webhook to call when the batch is broadcast

    // response:
    // - lnurlId, the id of the lnurl
    // - outputId, the id of the added output
    // - nbOutputs, the number of outputs currently in the batch
    // - oldest, the timestamp of the oldest output in the batch
    // - total, the current sum of the batch's output amounts

    // BODY {"address":"2N8DcqzfkYi8CkYzvNNS5amoq3SbAcQNXKp","amount":0.00233}
    // BODY {"address":"2N8DcqzfkYi8CkYzvNNS5amoq3SbAcQNXKp","amount":0.00233,"batchId":34,"webhookUrl":"https://myCypherApp:3000/batchExecuted"}
    // BODY {"address":"2N8DcqzfkYi8CkYzvNNS5amoq3SbAcQNXKp","amount":0.00233,"batchLabel":"lowfees","webhookUrl":"https://myCypherApp:3000/batchExecuted"}
    // BODY {"address":"2N8DcqzfkYi8CkYzvNNS5amoq3SbAcQNXKp","amount":0.00233,"batchId":34,"webhookUrl":"https://myCypherApp:3000/batchExecuted"}

    logger.info("CyphernodeClient.addToBatch:", batchRequestTO);

    const response = await this._post("/addtobatch", batchRequestTO);

    return this.handleResponse(response) as IRespAddToBatch;
  }

  async removeFromBatch(outputId: number): Promise<IRespAddToBatch> {
    // POST http://192.168.111.152:8080/removefrombatch
    //
    // args:
    // - outputId, required, id of the output to remove
    //
    // response:
    // - lnurlId, the id of the lnurl
    // - outputId, the id of the removed output if found
    // - nbOutputs, the number of outputs currently in the batch
    // - oldest, the timestamp of the oldest output in the batch
    // - total, the current sum of the batch's output amounts
    //
    // BODY {"id":72}

    logger.info("CyphernodeClient.removeFromBatch:", outputId);

    const response = await this._post("/removefrombatch", {
      outputId,
    });

    return this.handleResponse(response) as IRespAddToBatch;
  }

  async getBatchDetails(batchIdent: IReqGetBatchDetails): Promise<IRespGetBatchDetails> {
    // POST (GET) http://192.168.111.152:8080/getbatchdetails
    //
    // args:
    // - lnurlId, optional, id of the lnurl, overrides lnurlLabel, default lnurl will be spent if not supplied
    // - lnurlLabel, optional, label of the lnurl, default lnurl will be used if not supplied
    // - txid, optional, if you want the details of an executed batch, supply the batch txid, will return current pending batch
    //     if not supplied
    //
    // response:
    // {"result":{
    //    "lnurlId":34,
    //    "lnurlLabel":"Special lnurl for a special client",
    //    "confTarget":6,
    //    "nbOutputs":83,
    //    "oldest":123123,
    //    "total":10.86990143,
    //    "txid":"af867c86000da76df7ddb1054b273ca9e034e8c89d049b5b2795f9f590f67648",
    //    "hash":"af867c86000da76df7ddb1054b273ca9e034e8c89d049b5b2795f9f590f67648",
    //    "details":{
    //      "firstseen":123123,
    //      "size":424,
    //      "vsize":371,
    //      "replaceable":true,
    //      "fee":0.00004112
    //    },
    //    "outputs":[
    //      "1abc":0.12,
    //      "3abc":0.66,
    //      "bc1abc":2.848,
    //      ...
    //    ]
    //  }
    // },"error":null}
    //
    // BODY {}
    // BODY {"lnurlId":34}

    logger.info("CyphernodeClient.getBatchDetails:", batchIdent);

    const response = await this._post("/getbatchdetails", batchIdent);

    return this.handleResponse(response) as IRespGetBatchDetails;
  }

  async batchSpend(batchSpendTO: IReqBatchSpend): Promise<IRespBatchSpend> {
    // POST http://192.168.111.152:8080/batchspend
    //
    // args:
    // - lnurlId, optional, id of the lnurl to execute, overrides lnurlLabel, default lnurl will be spent if not supplied
    // - lnurlLabel, optional, label of the lnurl to execute, default lnurl will be executed if not supplied
    // - confTarget, optional, overrides default value of createlnurl, default to value of createlnurl, default Bitcoin Core conf_target will be used if not supplied
    // NOTYET - feeRate, optional, overrides confTarget if supplied, overrides default value of createlnurl, default to value of createlnurl, default Bitcoin Core value will be used if not supplied
    //
    // response:
    // - txid, the transaction txid
    // - hash, the transaction hash
    // - nbOutputs, the number of outputs spent in the batch
    // - oldest, the timestamp of the oldest output in the spent batch
    // - total, the sum of the spent batch's output amounts
    // - tx details: size, vsize, replaceable, fee
    // - outputs
    //
    // {"result":{
    //    "lnurlId":34,
    //    "lnurlLabel":"Special lnurl for a special client",
    //    "confTarget":6,
    //    "nbOutputs":83,
    //    "oldest":123123,
    //    "total":10.86990143,
    //    "txid":"af867c86000da76df7ddb1054b273ca9e034e8c89d049b5b2795f9f590f67648",
    //    "hash":"af867c86000da76df7ddb1054b273ca9e034e8c89d049b5b2795f9f590f67648",
    //    "details":{
    //      "firstseen":123123,
    //      "size":424,
    //      "vsize":371,
    //      "replaceable":true,
    //      "fee":0.00004112
    //    },
    //    "outputs":{
    //      "1abc":0.12,
    //      "3abc":0.66,
    //      "bc1abc":2.848,
    //      ...
    //    }
    //  }
    // },"error":null}
    //
    // BODY {}
    // BODY {"lnurlId":34,"confTarget":12}
    // NOTYET BODY {"lnurlLabel":"highfees","feeRate":233.7}
    // BODY {"lnurlId":411,"confTarget":6}

    logger.info("CyphernodeClient.batchSpend:", batchSpendTO);

    const response = await this._post("/batchspend", batchSpendTO);

    return this.handleResponse(response) as IRespBatchSpend;
  }

  async getTransaction(txId: string): Promise<IRespGetTransaction> {
    logger.info("CyphernodeClient.getTransaction", txId);

    // http://192.168.122.152:8080/gettransaction/af867c86000da76df7ddb1054b273ca9e034e8c89d049b5b2795f9f590f67648
    const response = await this._get("/gettransaction/" + txId);

    return this.handleResponse(response) as IRespGetTransaction;
  }

  async getElementsTransaction(txId: string): Promise<IRespGetTransaction> {
    logger.info("CyphernodeClient.getElementsTransaction", txId);

    // http://192.168.122.152:8080/elements_gettransaction/af867c86000da76df7ddb1054b273ca9e034e8c89d049b5b2795f9f590f67648
    const response = await this._get("/elements_gettransaction/" + txId);

    return this.handleResponse(response) as IRespGetTransaction;
  }

  async spend(spendTO: IReqSpend): Promise<IRespSpend> {
    // POST http://192.168.111.152:8080/spend
    // BODY {"address":"2N8DcqzfkYi8CkYzvNNS5amoq3SbAcQNXKp","amount":0.00233,"confTarget":6,"replaceable":true,"subtractfeefromamount":false}

    // args:
    // - address, required, desination address
    // - amount, required, amount to send to the destination address
    // - confTarget, optional, overrides default value, default Bitcoin Core conf_target will be used if not supplied
    // - replaceable, optional, overrides default value, default Bitcoin Core walletrbf will be used if not supplied
    // - subtractfeefromamount, optional, if true will subtract fee from the amount sent instead of adding to it
    //
    // response:
    // - txid, the transaction txid
    // - hash, the transaction hash
    // - tx details: address, aount, firstseen, size, vsize, replaceable, fee, subtractfeefromamount
    //
    // {"result":{
    //    "status":"accepted",
    //    "txid":"af867c86000da76df7ddb1054b273ca9e034e8c89d049b5b2795f9f590f67648",
    //    "hash":"af867c86000da76df7ddb1054b273ca9e034e8c89d049b5b2795f9f590f67648",
    //    "details":{
    //      "address":"2N8DcqzfkYi8CkYzvNNS5amoq3SbAcQNXKp",
    //      "amount":0.00233,
    //      "firstseen":123123,
    //      "size":424,
    //      "vsize":371,
    //      "replaceable":true,
    //      "fee":0.00004112,
    //      "subtractfeefromamount":true
    //    }
    //  }
    // },"error":null}
    //
    // BODY {"address":"2N8DcqzfkYi8CkYzvNNS5amoq3SbAcQNXKp","amount":0.00233}

    logger.info("CyphernodeClient.spend:", spendTO);

    const response = await this._post("/spend", spendTO);

    return this.handleResponse(response) as IRespSpend;
  }

  async elementsSpend(spendTO: IReqElementsSpend): Promise<IRespElementsSpend> {
    // BODY {"address":"AzpmavTHCTfJhUqoS28kg3aTmCzu9uqCdfkqmpCALetAoa3ERpZnHvhNzjMP3wo4XitKEMm62mjFk7B9","amount":0.00233,"confTarget":4,"assetId":"b2e15d0d7a0c94e4e2ce0fe6e8691b9e451377f6e46e8045a86f7c4b5d4f0f23"}

    logger.info("CyphernodeClient.elementsSpend:", spendTO);

    const response = await this._post("/elements_spend", spendTO);

    return this.handleResponse(response) as IRespElementsSpend;
  }

  async lnCreateInvoice(lnInvoice: IReqLnCreateInvoice): Promise<IRespLnCreateInvoice> {
    logger.info("CyphernodeClient.lnCreateInvoice", lnInvoice);

    // POST https://cyphernode/ln_create_invoice
    // BODY {"msatoshi":10000,"label":"koNCcrSvhX3dmyFhW","description":"Bylls order #10649","expiry":900,
    //   "callbackUrl":"https://thesite/lnwebhook/9d8sa98yd"}

    const response = await this._post("/ln_create_invoice", lnInvoice);

    logger.debug("CyphernodeClient.lnCreateInvoice :: response:", response);

    return this.handleResponse(response) as IRespLnCreateInvoice;

    // ln_createinvoice response from Cyphernode:
    // # {
    // #   "id":"",
    // #   "label":"",
    // #   "bolt11":"",
    // #   "connectstring":"",
    // #   "callbackUrl":"",
    // #   "payment_hash":"",
    // #   "msatoshi":,
    // #   "status":"unpaid",
    // #   "description":"",
    // #   "expires_at":
    // # }
  }

  async lnPay(lnPayTO: IReqLnPay): Promise<IRespLnPay> {
    // POST http://192.168.111.152:8080/ln_pay
    // BODY {"bolt11":"lntb1pdca82tpp5g[...]9wafq9n4w28amnmwzujgqpmapcr3",
    // "expected_msatoshi":"10000","expected_description":"Bitcoin Outlet order #7082"}

    // args:
    // - bolt11, required, lightning network bolt11 invoice
    // - expected_msatoshi, optional, amount we want to send, expected to be the same amount as the one encoded in the bolt11 invoice
    // - expected_description, optional, expected description encoded in the bolt11 invoice
    //
    //  Example of error result:
    //
    //  { "code" : 204, "message" : "failed: WIRE_TEMPORARY_CHANNEL_FAILURE (Outgoing subdaemon died)", "data" :
    //  {
    //    "erring_index": 0,
    //    "failcode": 4103,
    //    "erring_node": "031b867d9d6631a1352cc0f37bcea94bd5587a8d4f40416c4ce1a12511b1e68f56",
    //    "erring_channel": "1452982:62:0"
    //  } }
    //
    //
    //  Example of successful result:
    //
    //  {
    //    "id": 44,
    //    "payment_hash": "de648062da7117903291dab2075881e49ddd78efbf82438e4a2f486a7ebe0f3a",
    //    "destination": "02be93d1dad1ccae7beea7b42f8dbcfbdafb4d342335c603125ef518200290b450",
    //    "msatoshi": 207000,
    //    "msatoshi_sent": 207747,
    //    "created_at": 1548380406,
    //    "status": "complete",
    //    "payment_preimage": "a7ef27e9a94d63e4028f35ca4213fd9008227ad86815cd40d3413287d819b145",
    //    "description": "Order 43012 - Satoshi Larrivee",
    //    "getroute_tries": 1,
    //    "sendpay_tries": 1,
    //    "route": [
    //      {
    //        "id": "02be93d1dad1ccae7beea7b42f8dbcfbdafb4d342335c603125ef518200290b450",
    //        "channel": "1452749:174:0",
    //        "msatoshi": 207747,
    //        "delay": 10
    //      }
    //    ],
    //    "failures": [
    //    ]
    //  }

    logger.info("CyphernodeClient.lnPay:", lnPayTO);

    const response = await this._post("/ln_pay", lnPayTO);

    logger.debug("CyphernodeClient.lnPay :: response:", response);

    if (
      response.data.result === "error" &&
      response.data.expected_msatoshi &&
      response.data.invoice_msatoshi &&
      response.data.expected_msatoshi != response.data.invoice_msatoshi
    ) {
      response.data.error = {
        message: "Expected msatoshi <> Invoice msatoshi",
      };
    } else if (
      response.data.result === "error" &&
      response.data.expected_description &&
      response.data.invoice_description &&
      response.data.expected_description != response.data.invoice_description
    ) {
      response.data.error = {
        message: "Expected description <> Invoice description",
      };
    }

    return this.handleResponse(response) as IRespLnPay;
  }

  async wasabiGetNewAddress(
    wasabiGetNewAddress?: IReqWasabiGetNewAddress,
  ): Promise<IRespWasabiGetNewAddress> {
    // POST http://192.168.111.152:8080/wasabi_getnewaddress
    // BODY {"instanceId":0,"label":"Pay #12 for 2018"}
    // BODY {"label": "Pay #12 for 2018"}
    // BODY {}
    //
    // queries random instance for a new bech32 address
    // returns {"jsonrpc":"2.0","result":{"address":"tb1qpgpe7mdhdpgz6894vl5a2rhvhukwjc35h99rqc","keyPath":"84'/0'/0'/0/24","label":"blah","publicKey":"024eaa964530e5a72059951cdab8d22c5df7543536b011a8bab85bc1f6089654d9","p2wpkh":"00140a039f6db768502d1cb567e9d50eecbf2ce96234"},"id":"12"}

    logger.info("CyphernodeClient.wasabiGetNewAddress:", wasabiGetNewAddress);

    const response = await this._post("/wasabi_getnewaddress", wasabiGetNewAddress || {});

    return this.handleResponse(response) as IRespWasabiGetNewAddress;
  }

  async wasabiGetBalances(anonScore?: number): Promise<IRespWasabiGetBalances> {
    // GET http://192.168.111.152:8080/wasabi_getbalances
    // GET http://192.168.111.152:8080/wasabi_getbalances/100
    //
    // queries balances of all wasabi instances
    // returns {"result": {"0":{"private":4100000,"total":12215179},"1":{"private":3600000,"total":20917754},"all":{"private":7700000,"total":33132933}}}

    logger.info("CyphernodeClient.wasabiGetBalances:", anonScore);

    const response = await this._get(`/wasabi_getbalances${anonScore ? "/" + anonScore : ""}`);

    return this.handleResponse(response) as IRespWasabiGetBalances;
  }

  async wasabiSpend(wasabiSpend: IReqWasabiSpend): Promise<IRespWasabiSpend> {
    // args:
    // - instanceId: integer, optional
    // - private: boolean, optional, default=false
    // - address: string, required
    // - amount: number in BTC, required
    // - minanonset: number, optional
    // - label: number, optional
    // - confTarget: number, optional
    //
    // POST http://192.168.111.152:8080/wasabi_spend
    // BODY {"instanceId":1,"private":true,"amount":0.00103440,"address":"2N8DcqzfkYi8CkYzvNNS5amoq3SbAcQNXKp", label: "my super private coins", minanonset: 90, confTarget: 6}
    // BODY {"amount":0.00103440,"address":"2N8DcqzfkYi8CkYzvNNS5amoq3SbAcQNXKp"}

    logger.info("CyphernodeClient.wasabiSpend:", wasabiSpend);

    const response = await this._post("/wasabi_spend", wasabiSpend);

    return this.handleResponse(response) as IRespWasabiSpend;
  }

  async wasabiPayInCoinJoin(
    wasabiPayInCoinJoin: IReqWasabiPayInCoinJoin,
  ): Promise<IRespWasabiPayInCoinJoin> {
    // args:
    // - instanceId: integer, optional
    // - address: string, required
    // - amount: number in BTC, required
    //
    // POST http://192.168.111.152:8080/wasabi_payincoinjoin
    // BODY {"instanceId":1,"amount":0.00103440,"address":"2N8DcqzfkYi8CkYzvNNS5amoq3SbAcQNXKp", label: "my super private coins", minanonset: 90, confTarget: 6}
    // BODY {"amount":0.00103440,"address":"2N8DcqzfkYi8CkYzvNNS5amoq3SbAcQNXKp"}

    logger.info("CyphernodeClient.wasabiPayInCoinJoin:", wasabiPayInCoinJoin);

    const response = await this._post("/wasabi_payincoinjoin", wasabiPayInCoinJoin);

    return this.handleResponse(response) as IRespWasabiPayInCoinJoin;
  }

  async wasabiListPayInCoinJoin(instanceId: number): Promise<IRespWasabiListPayInCoinJoin> {
    // args:
    // - instanceId: integer, optional
    //
    // POST http://192.168.111.152:8080/wasabi_listpayincoinjoin
    // BODY {"instanceId":1}

    logger.info("CyphernodeClient.wasabiListPayInCoinJoin:", instanceId);

    const response = await this._post("/wasabi_listpayincoinjoin", { instanceId });

    return this.handleResponse(response) as IRespWasabiListPayInCoinJoin;
  }

  async wasabiCancelPayInCoinJoin(
    params: IReqWasabiCancelPayInCoinJoin,
  ): Promise<IRespWasabiCancelPayInCoinJoin> {
    // args:
    // - paymentId: string, required
    //
    // POST http://192.168.111.152:8080/wasabi_cancelpayincoinjoin
    // BODY {"instanceId":1,"paymentId":"a6ea81a46fec3d02d40815b8667b388351edecedc1cc9f97aab55b566db7aac8"}

    logger.info("CyphernodeClient.wasabiCƒancelPayInCoinJoin:", params);

    const response = await this._post("/wasabi_cancelpayincoinjoin", params);

    return this.handleResponse(response) as IRespWasabiCancelPayInCoinJoin;
  }

  async wasabiGetUnspentCoins(instanceId?: number): Promise<IRespWasabiGetUnspentCoins> {
    // args:
    // - instanceId: integer, optional
    // return all unspent coins of either one wasabi instance
    // or all instances, depending on the instanceId parameter
    //
    // GET http://192.168.111.152:8080/wasabi_getunspentcoins/{instanceId}

    logger.info("CyphernodeClient.wasabiGetUnspentCoins:", instanceId);

    const response = await this._get(
      `/wasabi_getunspentcoins${instanceId ? `/${instanceId}` : ""}`,
    );

    return this.handleResponse(response) as IRespWasabiGetUnspentCoins;
  }

  async wasabiSpendPrivate(): Promise<IRespWasabiSpend> {
    // GET http://192.168.111.152:8080/wasabi_spendprivate
    // Useful to manually trigger an auto-spend

    logger.info("CyphernodeClient.wasabiSpendPrivate:");

    const response = await this._get("/wasabi_spendprivate");

    return this.handleResponse(response) as IRespWasabiSpend;
  }

  async listUnspent(params: IReqListUnspent): Promise<IRespListUnspent> {
    logger.info("CyphernodeClient.listUnspent:", params);

    const response = await this._post("/listunspent", params);

    return this.handleResponse(response) as IRespListUnspent;
  }

  async sendMany(params: IReqSendMany): Promise<IRespSendMany> {
    logger.info("CyphernodeClient.sendMany:", params);

    const response = await this._post("/sendmany", params);

    return this.handleResponse(response) as IRespSendMany;
  }

  async createRawTransaction (params: IReqCreateRawTransaction): Promise<IRespCreateRawTransaction> { 
    logger.info("CyphernodeClient.createRawTransaction:", params);

    const response = await this._post("/createrawtransaction", params);

    return this.handleResponse(response) as IRespCreateRawTransaction;
  }

  async fundRawTransaction (params: IReqFundRawTransaction): Promise<IRespFundRawTransaction> {
    logger.info("CyphernodeClient.fundRawTransaction:", params);

    const response = await this._post("/fundrawtransaction", params);

    return this.handleResponse(response) as IRespFundRawTransaction;
  }

  async signRawTransaction (params: IReqSignRawTransaction): Promise<IRespSignRawTransaction> {
    logger.info("CyphernodeClient.signRawTransaction:", params);

    const response = await this._post("/signrawtransaction", params);

    return this.handleResponse(response) as IRespSignRawTransaction;
  }

  async decodeRawTransaction (params: IReqDecodeRawTransaction): Promise<IRespDecodeRawTransaction> {
    logger.info("CyphernodeClient.decodeRawTransaction:", params);

    const response = await this._post("/decoderawtransaction", params);

    return this.handleResponse(response) as IRespDecodeRawTransaction;
  }

  async sendRawTransaction (params: IReqSendRawTransaction): Promise<IRespSendRawTransaction> {
    logger.info("CyphernodeClient.sendRawTransaction:", params);

    const response = await this._post("/sendrawtransaction", params);

    return this.handleResponse(response) as IRespSendRawTransaction;
  }

  // POST http://192.168.111.152:8080/lockunspent
  // BODY {"unlock":true,"utxos":[{"txid":"af867c86000da76df7ddb1054b273ca9e034e8c89d049b5b2795f9f590f67648","vout":0}]}
  // BODY {"unlock":false,"utxos":[{"txid":"af867c86000da76df7ddb1054b273ca9e034e8c89d049b5b2795f9f590f67648","vout":0}]}
  // BODY {"unlock":false,"utxos":[{"txid":"af867c86000da76df7ddb1054b273ca9e034e8c89d049b5b2795f9f590f67648","vout":0}],"wallet":"01"}
  async lockUnspent (params: IReqLockUnspent): Promise<IRespLockUnspent> {
    logger.info("CyphernodeClient.lockUnspent:", params);

    const response = await this._post("/lockunspent", params);

    return this.handleResponse(response) as IRespLockUnspent;
  }

  async listLockUnspent (params: IReqListLockUnspent): Promise<IRespListLockUnspent> {
    logger.info("CyphernodeClient.listLockUnspent:");

    let uri = "/listlockunspent";
    if (params.wallet) {
      uri += `/${params.wallet}`;
    }
    const response = await this._get(uri);

    return this.handleResponse(response) as IRespListLockUnspent;
  }

  async getFeeRate (params: IReqGetFeeRate): Promise<IRespGetFeeRate> {
    logger.info("CyphernodeClient.getFeeRate:", params);

    const response = await this._post("/bitcoin_getfeerate", params);

    return this.handleResponse(response) as IRespGetFeeRate;
  }

  async validateAddress(address: string): Promise<IRespValidateAddress> {
    logger.info("CyphernodeClient.validateAddress:", address);

    const response = await this._get(`/validateaddress/${address}`);

    return this.handleResponse(response) as IRespValidateAddress;
  }
}

export { CyphernodeClient };
