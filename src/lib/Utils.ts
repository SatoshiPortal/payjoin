import axios, { AxiosError, AxiosHeaders, AxiosRequestConfig } from "axios";
import logger from "./Log2File";
import https from "https";
import { calculator } from "@dinero.js/calculator-bigint";
import {
  createDinero,
  toDecimal,
} from "dinero.js";

export const dineroBigInt = createDinero({ calculator });

class Utils {
  static omit<T extends object, K extends keyof T>(obj: T, keysToOmit: K[]): Omit<T, K> {
    const result: Partial<T> = {};

    for (const key in obj) {
      if (!keysToOmit.includes(key as unknown as K)) {
        result[key as keyof T] = obj[key];
      }
    }

    return result as Omit<T, K>;
  }

  static pick<T, K extends keyof T>(obj: T, keys: K[]): Pick<T, K> {
    return keys.reduce(
      (newObj, key) => {
        if (Object.prototype.hasOwnProperty.call(obj, key)) {
          newObj[key] = obj[key];
        }
        return newObj;
      },
      {} as Pick<T, K>,
    );
  }

  static async post(url: string, data: any, headers?: AxiosHeaders): Promise<any> {
    // use axios to send a POST request to url with the data

    logger.info("Utils.post:", url, data);

    const configs: AxiosRequestConfig = {
      url: url,
      method: "post",
      data,
      httpsAgent: new https.Agent({
        rejectUnauthorized: false,
      }),
    };
    if (headers) configs.headers = headers;

    //logger.debug("Utils.post :: configs:", configs);

    try {
      const response = await axios.request(configs);
      //logger.debug("Utils.post :: response.data:", response.data);

      return { status: response.status, data: response.data };
    } catch (err) {
      if (axios.isAxiosError(err)) {
        const error: AxiosError = err;

        if (error.response) {
          // The request was made and the server responded with a status code
          // that falls out of the range of 2xx
          logger.info("Utils.post :: error.response.data:", error.response.data);
          logger.info("Utils.post :: error.response.status:", error.response.status);
          logger.info("Utils.post :: error.response.headers:", error.response.headers);

          return { status: error.response.status, data: error.response.data };
        } else if (error.request) {
          // The request was made but no response was received
          // `error.request` is an instance of XMLHttpRequest in the browser and an instance of
          // http.ClientRequest in node.js
          logger.info("Utils.post :: error.message:", error.message);

          return { status: -1, data: error.message };
        } else {
          // Something happened in setting up the request that triggered an Error
          logger.info("Utils.post :: Error:", error.message);

          return { status: -2, data: error.message };
        }
      } else {
        return { status: -2, data: (err as any).message };
      }
    }
  }

  static satsToBtc(sats: bigint): string {
    const satsDinero = dineroBigInt({
      amount: sats,
      currency: {
        code: 'BTC',
        base: 10n,
        exponent: 8n,
      }
    });
    return toDecimal(satsDinero);
  }

  static btcToSats(btc: number | string): bigint {
    if (isNaN(Number(btc))) {
      throw new Error("Invalid number");
    }

    return BigInt(Math.floor(Number(btc) * 1e8));
  }

  static jsonReplacer(key: string, value: any): any {
    if (typeof value === "bigint") {
      return value.toString();
    } else if (Array.isArray(value)) {
      return value.map((v: any) => Utils.jsonReplacer(key, v));
    } else if (typeof value === "object" && value !== null && !(value instanceof Date)) {
      return Object.fromEntries(
        Object.entries(value).map(([key, val]) => [key, Utils.jsonReplacer(key, val)]),
      );
    }

    return value;
  }

  static jsonRevive<T>(obj: any, keys: string[]): any {
    for (const key in obj) {
      if (keys.includes(key as any)) {
        obj[key] = obj[key] ? BigInt(obj[key]) : obj[key];
      }
    }

    return obj as T;
  }

  static sanitizeResponse(obj: any): any {
    return Object.fromEntries(
      Object.entries(obj).map(([key, val]) => [key, Utils.jsonReplacer(key, val)]),
    );
  }

  static jsonStringify(obj: any, pretty: boolean = false): string {
    return JSON.stringify(obj, Utils.jsonReplacer, pretty ? 2 : 0);
  }
}

export default Utils;
