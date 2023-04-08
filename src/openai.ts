import { Request, Response, NextFunction, Router } from "express";
import * as http from "http";
import { createProxyMiddleware } from "http-proxy-middleware";
import { logger } from "./logger";
import { keys } from "./keys";

/**
 * Modifies the request body to add a randomly selected API key.
 */
const rewriteRequest = (proxyReq: http.ClientRequest, req: Request) => {
  const key = keys.get(req.body?.model || "gpt-3.5")!;

  proxyReq.setHeader("Authorization", `Bearer ${key}`);
  if (req.body?.stream) {
    req.body.stream = false;
    const updatedBody = JSON.stringify(req.body);
    proxyReq.setHeader("Content-Length", Buffer.byteLength(updatedBody));
    proxyReq.write(updatedBody);
    proxyReq.end();
  }
};

const handleResponse = (
  proxyRes: http.IncomingMessage,
  req: Request,
  res: Response
) => {
  const { method, path } = req;
  const statusCode = proxyRes.statusCode || 500;

  if (statusCode === 429) {
    // TODO: Handle rate limit by temporarily removing that key from the pool
    logger.warn(`OpenAI rate limit exceeded: ${method} ${path}`);
  } else if (statusCode >= 400) {
    logger.warn(`OpenAI error: ${method} ${path} ${statusCode}`);
  } else {
    logger.info(`OpenAI request: ${method} ${path} ${statusCode}`);
  }

  proxyRes.pipe(res);
};

const openaiProxy = createProxyMiddleware({
  target: "https://api.openai.com",
  changeOrigin: true,
  onProxyReq: rewriteRequest,
  onProxyRes: handleResponse,
  selfHandleResponse: true,
  pathRewrite: {
    "^/proxy/openai": "",
  },
});

export const openaiRouter = Router();
openaiRouter.post("/v1/chat/completions", openaiProxy);
// openaiRouter.post("/v1/completions", openaiProxy);
// openaiRouter.get("/v1/models", handleModels);
// openaiRouter.get("/dashboard/billing/usage, handleUsage);
openaiRouter.use((req, res) => {
  logger.warn(`Blocked openai proxy request: ${req.method} ${req.path}`);
  res.status(404).json({ error: "Not found" });
});
