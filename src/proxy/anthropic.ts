import { Request, Router } from "express";
import * as http from "http";
import { createProxyMiddleware } from "http-proxy-middleware";
import { config } from "../config";
import { logger } from "../logger";
import {
  addKey,
  finalizeBody,
  languageFilter,
  limitOutputTokens,
  setApiFormat,
  transformOutboundPayload,
} from "./middleware/request";
import {
  ProxyResHandlerWithBody,
  createOnProxyResHandler,
  handleInternalError,
} from "./middleware/response";
import { createQueueMiddleware } from "./queue";

const rewriteAnthropicRequest = (
  proxyReq: http.ClientRequest,
  req: Request,
  res: http.ServerResponse
) => {
  const rewriterPipeline = [
    addKey,
    languageFilter,
    limitOutputTokens,
    transformOutboundPayload,
    finalizeBody,
  ];

  try {
    for (const rewriter of rewriterPipeline) {
      rewriter(proxyReq, req, res, {});
    }
  } catch (error) {
    req.log.error(error, "Error while executing proxy rewriter");
    proxyReq.destroy(error as Error);
  }
};

/** Only used for non-streaming requests. */
const anthropicResponseHandler: ProxyResHandlerWithBody = async (
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

  if (!req.originalUrl.includes("/v1/complete")) {
    req.log.info("Transforming Anthropic response to OpenAI format");
    body = transformAnthropicResponse(body);
  }
  res.status(200).json(body);
};

/**
 * Transforms a model response from the Anthropic API to match those from the
 * OpenAI API, for users using Claude via the OpenAI-compatible endpoint. This
 * is only used for non-streaming requests as streaming requests are handled
 * on-the-fly.
 */
function transformAnthropicResponse(
  anthropicBody: Record<string, any>
): Record<string, any> {
  return {
    id: "ant-" + anthropicBody.log_id,
    object: "chat.completion",
    created: Date.now(),
    model: anthropicBody.model,
    usage: {
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
    },
    choices: [
      {
        message: {
          role: "assistant",
          content: anthropicBody.completion?.trim(),
        },
        finish_reason: anthropicBody.stop_reason,
        index: 0,
      },
    ],
  };
}

const anthropicProxy = createProxyMiddleware({
  target: "https://api.anthropic.com",
  changeOrigin: true,
  on: {
    proxyReq: rewriteAnthropicRequest,
    proxyRes: createOnProxyResHandler([anthropicResponseHandler]),
    error: handleInternalError,
  },
  selfHandleResponse: true,
  logger,
  pathRewrite: {
    // Send OpenAI-compat requests to the real Anthropic endpoint.
    "^/v1/chat/completions": "/v1/complete",
  },
});
const queuedAnthropicProxy = createQueueMiddleware(anthropicProxy);

const anthropicRouter = Router();
// Fix paths because clients don't consistently use the /v1 prefix.
anthropicRouter.use((req, _res, next) => {
  if (!req.path.startsWith("/v1/")) {
    req.url = `/v1${req.url}`;
  }
  next();
});
anthropicRouter.get("/v1/models", (req, res) => {
  res.json(buildFakeModelsResponse());
});
anthropicRouter.post(
  "/v1/complete",
  setApiFormat({ in: "anthropic", out: "anthropic" }),
  queuedAnthropicProxy
);
// OpenAI-to-Anthropic compatibility endpoint.
anthropicRouter.post(
  "/v1/chat/completions",
  setApiFormat({ in: "openai", out: "anthropic" }),
  queuedAnthropicProxy
);
// Redirect browser requests to the homepage.
anthropicRouter.get("*", (req, res, next) => {
  const isBrowser = req.headers["user-agent"]?.includes("Mozilla");
  if (isBrowser) {
    res.redirect("/");
  } else {
    next();
  }
});

let modelsCache: any = null;
let modelsCacheTime = 0;

function buildFakeModelsResponse() {
  if (new Date().getTime() - modelsCacheTime < 1000 * 60) {
    return modelsCache;
  }

  if (!config.anthropicKey) return { object: "list", data: [] };

  const claudeVariants = [
    "claude-v1",
    "claude-v1-100k",
    "claude-instant-v1",
    "claude-instant-v1-100k",
    "claude-v1.3",
    "claude-v1.3-100k",
    "claude-v1.2",
    "claude-v1.0",
    "claude-instant-v1.1",
    "claude-instant-v1.1-100k",
    "claude-instant-v1.0",
  ];

  const models = claudeVariants.map((id) => ({
    id,
    object: "model",
    created: new Date().getTime(),
    owned_by: "anthropic",
    permission: [],
    root: "claude",
    parent: null,
  }));

  modelsCache = { object: "list", data: models };
  modelsCacheTime = new Date().getTime();

  return modelsCache;
}

export const anthropic = anthropicRouter;
