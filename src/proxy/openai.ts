import { Request, Router } from "express";
import * as http from "http";
import { createProxyMiddleware } from "http-proxy-middleware";
import { logger } from "../logger";
import { handleResponse, onError } from "./common";
import { ipLimiter } from "./rate-limit";
import {
  addKey,
  disableStream,
  finalizeBody,
  limitOutputTokens,
} from "./rewriters";

const rewriteRequest = (
  proxyReq: http.ClientRequest,
  req: Request,
  res: http.ServerResponse
) => {
  const rewriterPipeline = [
    addKey,
    disableStream,
    limitOutputTokens,
    finalizeBody,
  ];

  try {
    for (const rewriter of rewriterPipeline) {
      rewriter(proxyReq, req, res, {});
    }
  } catch (error) {
    logger.error(error, "Error while executing proxy rewriter");
    proxyReq.destroy(error as Error);
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
openaiRouter.get("/v1/models", openaiProxy);
// openaiRouter.post("/v1/completions", openaiProxy); // TODO: Implement Davinci
openaiRouter.post("/v1/chat/completions", ipLimiter, openaiProxy);
openaiRouter.use((req, res) => {
  logger.warn(`Blocked openai proxy request: ${req.method} ${req.path}`);
  res.status(404).json({ error: "Not found" });
});


export const openai = openaiRouter;
