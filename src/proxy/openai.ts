import { Request, Response, Router } from "express";
import * as http from "http";
import { createProxyMiddleware } from "http-proxy-middleware";
import { logger } from "../logger";
import {
  handleDownstreamErrors,
  handleInternalError,
  incrementKeyUsage,
  copyHttpHeaders,
} from "./common";
import { ipLimiter } from "./rate-limit";
import {
  addKey,
  languageFilter,
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
    languageFilter,
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

const handleProxiedResponse = async (
  proxyRes: http.IncomingMessage,
  req: Request,
  res: Response
) => {
  try {
    await handleDownstreamErrors(proxyRes, req, res);
  } catch (error) {
    // Handler takes over the response, we're done here.
    return;
  }
  incrementKeyUsage(req);
  copyHttpHeaders(proxyRes, res);
  proxyRes.pipe(res);
};

const openaiProxy = createProxyMiddleware({
  target: "https://api.openai.com",
  changeOrigin: true,
  on: {
    proxyReq: rewriteRequest,
    proxyRes: handleProxiedResponse,
    error: handleInternalError,
  },
  selfHandleResponse: true,
  logger,
});

const openaiRouter = Router();
openaiRouter.get("/v1/models", openaiProxy);
openaiRouter.post("/v1/chat/completions", ipLimiter, openaiProxy);
openaiRouter.use((req, res) => {
  logger.warn(`Blocked openai proxy request: ${req.method} ${req.path}`);
  res.status(404).json({ error: "Not found" });
});

export const openai = openaiRouter;
