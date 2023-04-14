import { Request, Response, Router } from "express";
import * as http from "http";
import { createProxyMiddleware } from "http-proxy-middleware";
import { logger } from "../logger";
import {
  createOnProxyResHandler,
  handleInternalError,
  ProxyResHandlerWithBody,
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

const openaiResponseHandler: ProxyResHandlerWithBody = async (
  _proxyRes,
  _req,
  res,
  body
) => {
  if (typeof body !== "object") {
    throw new Error("Expected body to be an object");
  }
  res.status(200).json(body);
};

const openaiProxy = createProxyMiddleware({
  target: "https://api.openai.com",
  changeOrigin: true,
  on: {
    proxyReq: rewriteRequest,
    proxyRes: createOnProxyResHandler([openaiResponseHandler]),
    error: handleInternalError,
  },
  selfHandleResponse: true,
  logger,
});

const openaiRouter = Router();
// Some clients don't include the /v1/ prefix in their requests and users get
// confused when they get a 404. Just fix the route for them so I don't have to
// provide a bunch of different routes for each client's idiosyncrasies.
openaiRouter.use((req, _res, next) => {
  if (!req.path.startsWith("/v1/")) {
    req.url = `/v1${req.url}`;
  }
  next();
});
openaiRouter.get("/v1/models", openaiProxy);
openaiRouter.post("/v1/chat/completions", ipLimiter, openaiProxy);
openaiRouter.use((req, res) => {
  logger.warn(`Blocked openai proxy request: ${req.method} ${req.path}`);
  res.status(404).json({ error: "Not found" });
});

export const openai = openaiRouter;
