import { Request, Router } from "express";
import * as http from "http";
import { createProxyMiddleware } from "http-proxy-middleware";
import { config } from "../config";
import { logger } from "../logger";
import { ipLimiter } from "./rate-limit";
import {
  addKey,
  languageFilter,
  disableStream,
  finalizeBody,
  limitOutputTokens,
  limitCompletions,
} from "./middleware/request";
import {
  createOnProxyResHandler,
  handleInternalError,
  ProxyResHandlerWithBody,
} from "./middleware/response";

const rewriteRequest = (
  proxyReq: http.ClientRequest,
  req: Request,
  res: http.ServerResponse
) => {
  req.api = "openai";
  const rewriterPipeline = [
    addKey,
    languageFilter,
    disableStream,
    limitOutputTokens,
    limitCompletions,
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
  req,
  res,
  body
) => {
  if (typeof body !== "object") {
    throw new Error("Expected body to be an object");
  }

  if (config.promptLogging) {
    const host = req.get("host");
    body.proxy_note = `Prompts are logged on this proxy instance. See ${host} for more information.`;
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
// If a browser tries to visit a route that doesn't exist, redirect to the info
// page to help them find the right URL.
openaiRouter.get("*", (req, res, next) => {
  const isBrowser = req.headers["user-agent"]?.includes("Mozilla");
  if (isBrowser) {
    res.redirect("/");
  } else {
    next();
  }
});
openaiRouter.use((req, res) => {
  logger.warn(`Blocked openai proxy request: ${req.method} ${req.path}`);
  res.status(404).json({ error: "Not found" });
});

export const openai = openaiRouter;
