import express, { Application, Request, Response, NextFunction } from "express";
import { JSONRPCServer } from 'json-rpc-2.0';
import logger from "../lib/Log2File";
import Utils from "../lib/Utils";
import { handleAddressCallback } from "./callback";
import { registerConfigApi } from "./config";
import { registerReceiveApi } from "./receive";
import { registerSendApi } from "./send";

const server = new JSONRPCServer();

const jsonBigIntMiddleware = (req: Request, res: Response, next: NextFunction) => {
  res.json = function (data: any): Response {
    const jsonString = JSON.stringify(data, Utils.jsonReplacer);
    res.setHeader('Content-Type', 'application/json');
    return res.send(jsonString);
  };
  next();
};

export function jsonRpcMiddleware() {
  return (req: Request, res: Response, next: NextFunction) => {
    if (req.method === 'POST' && req.is('application/json')) {
      Promise.resolve(server.receive(req.body)).then((jsonRPCResponse) => {
        if (jsonRPCResponse) {
          res.json(jsonRPCResponse);
        } else {
          res.sendStatus(204);
        }
      }).catch((error) => {
        logger.error('Error processing JSON-RPC request:', error); // Log any errors
        res.status(500).json({ error: 'Internal Server Error' });
      });
    } else {
      next();
    }
  };
}

export function addJsonRpcMethod(name: string, handler: (params: any) => any) {
  server.addMethod(name, handler);
}

export function registerApi(app: Application): void {
  logger.info('registerApi');

  app.use(jsonBigIntMiddleware);
  app.use(express.json());
  app.post('/jsonrpc', jsonRpcMiddleware());

  registerConfigApi();
  registerSendApi();
  registerReceiveApi();

  // address callback handler for watching addresses
  app.post('/send/address/*', async (req: Request, res: Response) => {
    handleAddressCallback(req.body, "send").catch((e: any) => {
      logger.error('callback', 'Failed to handle address callback:', e);
    });
    res.sendStatus(200);
  });

  app.post('/receive/address/*', async (req: Request, res: Response) => {
    handleAddressCallback(req.body, "receive").catch((e: any) => {
      logger.error('callback', 'Failed to handle address callback:', e);
    });
    res.sendStatus(200);
  });
}