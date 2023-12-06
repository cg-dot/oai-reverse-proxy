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
  finalizeSignedRequest,
  createOnProxyReqHandler,
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
      proxyReq: createOnProxyReqHandler({
        pipeline: [
          applyQuotaLimits,
          blockZoomerOrigins,
          stripHeaders,
          finalizeSignedRequest,
        ],
      }),
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
const LATEST_AWS_V2_MINOR_VERSION = '1';

function maybeReassignModel(req: Request) {
  const model = req.body.model;

  // If the string already includes "anthropic.claude", return it unmodified
  if (model.includes("anthropic.claude")) {
    return;
  }

  // Define a regular expression pattern to match the Claude version strings
  const pattern = /^(claude-)?(instant-)?(v)?(\d+)(\.(\d+))?(-\d+k)?$/i;

  // Execute the pattern on the model string
  const match = model.match(pattern);

  // If there's no match, return the latest v2 model
  if (!match) {
    req.body.model = `anthropic.claude-v2:${LATEST_AWS_V2_MINOR_VERSION}`;
    return;
  }

  // Extract parts of the version string
  const [, , instant, v, major, , minor] = match;

  // If 'instant' is part of the version, return the fixed instant model string
  if (instant) {
    req.body.model = 'anthropic.claude-instant-v1';
    return;
  }

  // If the major version is '1', return the fixed v1 model string
  if (major === '1') {
    req.body.model = 'anthropic.claude-v1';
    return;
  }

  // If the major version is '2'
  if (major === '2') {
    // If the minor version is explicitly '0', return "anthropic.claude-v2" which is claude-2.0
    if (minor === '0') {
      req.body.model = 'anthropic.claude-v2';
      return;
    }
    // Otherwise, return the v2 model string with the latest minor version
    req.body.model = `anthropic.claude-v2:${LATEST_AWS_V2_MINOR_VERSION}`;
    return;
  }

  // If none of the above conditions are met, return the latest v2 model by default
  req.body.model = `anthropic.claude-v2:${LATEST_AWS_V2_MINOR_VERSION}`;
  return;
}

export const aws = awsRouter;
