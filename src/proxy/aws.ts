import { Request, RequestHandler, Router } from "express";
import { createProxyMiddleware } from "http-proxy-middleware";
import { v4 } from "uuid";
import { config } from "../config";
import { logger } from "../logger";
import { createQueueMiddleware } from "./queue";
import { ipLimiter } from "./rate-limit";
import { handleProxyError } from "./middleware/common";
import {
  createPreprocessorMiddleware,
  signAwsRequest,
  finalizeSignedRequest,
  createOnProxyReqHandler,
} from "./middleware/request";
import {
  ProxyResHandlerWithBody,
  createOnProxyResHandler,
} from "./middleware/response";

const LATEST_AWS_V2_MINOR_VERSION = "1";

let modelsCache: any = null;
let modelsCacheTime = 0;

const getModelsResponse = () => {
  if (new Date().getTime() - modelsCacheTime < 1000 * 60) {
    return modelsCache;
  }

  if (!config.awsCredentials) return { object: "list", data: [] };

  const variants = [
    "anthropic.claude-v1",
    "anthropic.claude-v2",
    "anthropic.claude-v2:1",
  ];

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

  if (req.tokenizerInfo) {
    body.proxy_tokenizer = req.tokenizerInfo;
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

const awsProxy = createQueueMiddleware({
  beforeProxy: signAwsRequest,
  proxyMiddleware: createProxyMiddleware({
    target: "bad-target-will-be-rewritten",
    router: ({ signedRequest }) => {
      if (!signedRequest) throw new Error("Must sign request before proxying");
      return `${signedRequest.protocol}//${signedRequest.hostname}`;
    },
    changeOrigin: true,
    selfHandleResponse: true,
    logger,
    on: {
      proxyReq: createOnProxyReqHandler({ pipeline: [finalizeSignedRequest] }),
      proxyRes: createOnProxyResHandler([awsResponseHandler]),
      error: handleProxyError,
    },
  }),
});

const awsRouter = Router();
awsRouter.get("/v1/models", handleModelRequest);
// Native(ish) Anthropic chat completion endpoint.
awsRouter.post(
  "/v1/complete",
  ipLimiter,
  createPreprocessorMiddleware(
    { inApi: "anthropic", outApi: "anthropic", service: "aws" },
    { afterTransform: [maybeReassignModel] }
  ),
  awsProxy
);
// OpenAI-to-AWS Anthropic compatibility endpoint.
awsRouter.post(
  "/v1/chat/completions",
  ipLimiter,
  createPreprocessorMiddleware(
    { inApi: "openai", outApi: "anthropic", service: "aws" },
    { afterTransform: [maybeReassignModel] }
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

  // If client already specified an AWS Claude model ID, use it
  if (model.includes("anthropic.claude")) {
    return;
  }

  const pattern = /^(claude-)?(instant-)?(v)?(\d+)(\.(\d+))?(-\d+k)?$/i;
  const match = model.match(pattern);

  // If there's no match, return the latest v2 model
  if (!match) {
    req.body.model = `anthropic.claude-v2:${LATEST_AWS_V2_MINOR_VERSION}`;
    return;
  }

  const [, , instant, , major, , minor] = match;

  if (instant) {
    req.body.model = "anthropic.claude-instant-v1";
    return;
  }

  // There's only one v1 model
  if (major === "1") {
    req.body.model = "anthropic.claude-v1";
    return;
  }

  // Try to map Anthropic API v2 models to AWS v2 models
  if (major === "2") {
    if (minor === "0") {
      req.body.model = "anthropic.claude-v2";
      return;
    }
    req.body.model = `anthropic.claude-v2:${LATEST_AWS_V2_MINOR_VERSION}`;
    return;
  }

  // Fallback to latest v2 model
  req.body.model = `anthropic.claude-v2:${LATEST_AWS_V2_MINOR_VERSION}`;
  return;
}

export const aws = awsRouter;
