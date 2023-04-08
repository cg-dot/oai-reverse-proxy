import { Request, Router } from "express";
import * as http from "http";
import { createProxyMiddleware, fixRequestBody } from "http-proxy-middleware";
import { logger } from "../logger";
import { Key, keys } from "../keys";
import { handleResponse, onError } from "./common";

/**
 * Modifies the request body to add a randomly selected API key.
 */
const rewriteRequest = (proxyReq: http.ClientRequest, req: Request) => {
  let key: Key;

  try {
    key = keys.get(req.body?.model || "gpt-3.5")!;
  } catch (err) {
    proxyReq.destroy(err as any);
    return;
  }

  req.key = key;
  proxyReq.setHeader("Authorization", `Bearer ${key.key}`);

  if (req.method === "POST" && req.body) {
    if (req.body?.stream) {
      req.body.stream = false;
      const updatedBody = JSON.stringify(req.body);
      proxyReq.setHeader("Content-Length", Buffer.byteLength(updatedBody));
      (req as any).rawBody = Buffer.from(updatedBody);
    }

    // body-parser and http-proxy-middleware don't play nice together
    fixRequestBody(proxyReq, req);
  }
};

const openaiProxy = createProxyMiddleware({
  target: "https://api.openai.com",
  changeOrigin: true,
  on: {
    proxyReq: rewriteRequest,
    proxyRes: handleResponse,
    error: onError,
  },
  selfHandleResponse: true,
  logger,
});

const openaiRouter = Router();
openaiRouter.post("/v1/chat/completions", openaiProxy);
// openaiRouter.post("/v1/completions", openaiProxy); // TODO: Implement Davinci
openaiRouter.get("/v1/models", openaiProxy);
openaiRouter.use((req, res) => {
  logger.warn(`Blocked openai proxy request: ${req.method} ${req.path}`);
  res.status(404).json({ error: "Not found" });
});

export const openai = openaiRouter;
