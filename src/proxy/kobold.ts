/* Pretends to be a KoboldAI API endpoint and translates incoming Kobold
requests to OpenAI API equivalents. */

import { Request, Response, Router } from "express";
import http from "http";
import { createProxyMiddleware } from "http-proxy-middleware";
import { config } from "../config";
import { logger } from "../logger";
import { ipLimiter } from "./rate-limit";
import { handleProxyError } from "./middleware/common";
import {
  addKey,
  createPreprocessorMiddleware,
  finalizeBody,
  languageFilter,
  limitOutputTokens,
  transformKoboldPayload,
} from "./middleware/request";
import {
  createOnProxyResHandler,
  ProxyResHandlerWithBody,
} from "./middleware/response";

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
  if (config.queueMode !== "none") {
    const msg = `Queueing is enabled on this proxy instance and is incompatible with the KoboldAI endpoint. Use the OpenAI endpoint instead.`;
    proxyReq.destroy(new Error(msg));
    return;
  }

  req.body.stream = false;
  const rewriterPipeline = [
    addKey,
    transformKoboldPayload,
    languageFilter,
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

const koboldResponseHandler: ProxyResHandlerWithBody = async (
  _proxyRes,
  req,
  res,
  body
) => {
  if (typeof body !== "object") {
    throw new Error("Expected body to be an object");
  }

  const koboldResponse = {
    results: [{ text: body.choices[0].message.content }],
    model: body.model,
    ...(config.promptLogging && {
      proxy_note: `Prompt logging is enabled on this proxy instance. See ${req.get(
        "host"
      )} for more information.`,
    }),
  };

  res.send(JSON.stringify(koboldResponse));
};

const koboldOaiProxy = createProxyMiddleware({
  target: "https://api.openai.com",
  changeOrigin: true,
  pathRewrite: {
    "^/api/v1/generate": "/v1/chat/completions",
  },
  on: {
    proxyReq: rewriteRequest,
    proxyRes: createOnProxyResHandler([koboldResponseHandler]),
    error: handleProxyError,
  },
  selfHandleResponse: true,
  logger,
});

const koboldRouter = Router();
koboldRouter.get("/api/v1/model", handleModelRequest);
koboldRouter.get("/api/v1/config/soft_prompts_list", handleSoftPromptsRequest);
koboldRouter.post(
  "/api/v1/generate",
  ipLimiter,
  createPreprocessorMiddleware({ inApi: "kobold", outApi: "openai" }),
  koboldOaiProxy
);
koboldRouter.use((req, res) => {
  logger.warn(`Unhandled kobold request: ${req.method} ${req.path}`);
  res.status(404).json({ error: "Not found" });
});

export const kobold = koboldRouter;
