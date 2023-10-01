import { Request, RequestHandler, Router } from "express";
import { createProxyMiddleware } from "http-proxy-middleware";
import { v4 } from "uuid";
import { config } from "../config";
import { logger } from "../logger";
import { createQueueMiddleware } from "./queue";
import { ipLimiter } from "./rate-limit";
import { handleProxyError } from "./middleware/common";
import {
  applyQuotaLimits,
  createPreprocessorMiddleware,
  stripHeaders,
  signAwsRequest,
  finalizeAwsRequest,
  createOnProxyReqHandler,
  languageFilter,
  blockZoomerOrigins,
} from "./middleware/request";
import {
  ProxyResHandlerWithBody,
  createOnProxyResHandler,
} from "./middleware/response";

let modelsCache: any = null;
let modelsCacheTime = 0;

const getModelsResponse = () => {
  if (new Date().getTime() - modelsCacheTime < 1000 * 60) {
    return modelsCache;
  }

  if (!config.awsCredentials) return { object: "list", data: [] };

  const variants = ["anthropic.claude-v1", "anthropic.claude-v2"];

  const models = variants.map((id) => ({
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
};

const handleModelRequest: RequestHandler = (_req, res) => {
  res.status(200).json(getModelsResponse());
};

/** Only used for non-streaming requests. */
const awsResponseHandler: ProxyResHandlerWithBody = async (
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

  if (req.inboundApi === "openai") {
    req.log.info("Transforming AWS Claude response to OpenAI format");
    body = transformAwsResponse(body, req);
  }

  // TODO: Remove once tokenization is stable
  if (req.debug) {
    body.proxy_tokenizer_debug_info = req.debug;
  }

  // AWS does not confirm the model in the response, so we have to add it
  body.model = req.body.model;

  res.status(200).json(body);
};

/**
 * Transforms a model response from the Anthropic API to match those from the
 * OpenAI API, for users using Claude via the OpenAI-compatible endpoint. This
 * is only used for non-streaming requests as streaming requests are handled
 * on-the-fly.
 */
function transformAwsResponse(
  awsBody: Record<string, any>,
  req: Request
): Record<string, any> {
  const totalTokens = (req.promptTokens ?? 0) + (req.outputTokens ?? 0);
  return {
    id: "aws-" + v4(),
    object: "chat.completion",
    created: Date.now(),
    model: req.body.model,
    usage: {
      prompt_tokens: req.promptTokens,
      completion_tokens: req.outputTokens,
      total_tokens: totalTokens,
    },
    choices: [
      {
        message: {
          role: "assistant",
          content: awsBody.completion?.trim(),
        },
        finish_reason: awsBody.stop_reason,
        index: 0,
      },
    ],
  };
}

const awsProxy = createQueueMiddleware(
  createProxyMiddleware({
    target: "bad-target-will-be-rewritten",
    router: ({ signedRequest }) => {
      if (!signedRequest) {
        throw new Error("AWS requests must go through signAwsRequest first");
      }
      return `${signedRequest.protocol}//${signedRequest.hostname}`;
    },
    changeOrigin: true,
    selfHandleResponse: true,
    logger,
    on: {
      proxyReq: createOnProxyReqHandler({
        pipeline: [
          applyQuotaLimits,
          // Credentials are added by signAwsRequest preprocessor
          languageFilter,
          blockZoomerOrigins,
          stripHeaders,
          finalizeAwsRequest,
        ],
      }),
      proxyRes: createOnProxyResHandler([awsResponseHandler]),
      error: handleProxyError,
    },
  })
);

const awsRouter = Router();
awsRouter.get("/v1/models", handleModelRequest);
// Native(ish) Anthropic chat completion endpoint.
awsRouter.post(
  "/v1/complete",
  ipLimiter,
  createPreprocessorMiddleware(
    { inApi: "anthropic", outApi: "anthropic", service: "aws" },
    { afterTransform: [maybeReassignModel, signAwsRequest] }
  ),
  awsProxy
);
// OpenAI-to-AWS Anthropic compatibility endpoint.
awsRouter.post(
  "/v1/chat/completions",
  ipLimiter,
  createPreprocessorMiddleware(
    { inApi: "openai", outApi: "anthropic", service: "aws" },
    { afterTransform: [maybeReassignModel, signAwsRequest] }
  ),
  awsProxy
);

/**
 * Tries to deal with:
 * - frontends sending AWS model names even when they want to use the OpenAI-
 *   compatible endpoint
 * - frontends sending Anthropic model names that AWS doesn't recognize
 * - frontends sending OpenAI model names because they expect the proxy to
 *   translate them
 */
function maybeReassignModel(req: Request) {
  const model = req.body.model;
  // User's client sent an AWS model already
  if (model.includes("anthropic.claude")) return;
  // User's client is sending Anthropic-style model names, check for v1
  if (model.match(/^claude-v?1/)) {
    req.body.model = "anthropic.claude-v1";
  } else {
    // User's client requested v2 or possibly some OpenAI model, default to v2
    req.body.model = "anthropic.claude-v2";
  }
  // TODO: Handle claude-instant
}

export const aws = awsRouter;
