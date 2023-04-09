/* Pretends to be a KoboldAI API endpoint and translates incoming Kobold
requests to OpenAI API equivalents. */

import { Request, Response, Router } from "express";
import http from "http";
import { createProxyMiddleware } from "http-proxy-middleware";
import { logger } from "../logger";
import {
  copyHttpHeaders,
  handleDownstreamErrors,
  handleInternalError,
  incrementKeyUsage,
} from "./common";
import {
  addKey,
  disableStream,
  finalizeBody,
  languageFilter,
  limitOutputTokens,
} from "./rewriters";
import { transformKoboldPayload } from "./rewriters/transform-kobold-payload";

export const handleModelRequest = (_req: Request, res: Response) => {
  res.status(200).json({ result: "Connected to OpenAI reverse proxy" });
};

export const handleSoftPromptsRequest = (_req: Request, res: Response) => {
  res.status(200).json({ soft_prompts_list: [] });
};

const rewriteRequest = (
  proxyReq: http.ClientRequest,
  req: Request,
  res: Response
) => {
  const rewriterPipeline = [
    addKey,
    transformKoboldPayload,
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

  // For Kobold we need to consume the response body to turn it into a KoboldAI
  // response payload.
  let body = "";
  proxyRes.on("data", (chunk) => (body += chunk));
  proxyRes.on("end", () => {
    const response = JSON.parse(body);
    const koboldResponse = {
      results: [{ text: response.choices[0].message.content }],
    };
    res.status(200).json(koboldResponse);
  });
};

const koboldOaiProxy = createProxyMiddleware({
  target: "https://api.openai.com",
  changeOrigin: true,
  pathRewrite: {
    "^/api/v1/generate": "/v1/chat/completions",
  },
  on: {
    proxyReq: rewriteRequest,
    proxyRes: handleProxiedResponse,
    error: handleInternalError,
  },
  selfHandleResponse: true,
  logger,
});

const koboldRouter = Router();
koboldRouter.get("/api/v1/model", handleModelRequest);
koboldRouter.get("/api/v1/config/soft_prompts_list", handleSoftPromptsRequest);
koboldRouter.post("/api/v1/generate", koboldOaiProxy);
koboldRouter.use((req, res) => {
  logger.warn(`Unhandled kobold request: ${req.method} ${req.path}`);
  res.status(404).json({ error: "Not found" });
});

export const kobold = koboldRouter;
