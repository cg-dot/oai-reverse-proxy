import { Request, Response, RequestHandler, Router } from "express";
import { createProxyMiddleware } from "http-proxy-middleware";
import { config } from "../config";
import { logger } from "../logger";
import { createQueueMiddleware } from "./queue";
import { ipLimiter } from "./rate-limit";
import { handleProxyError } from "./middleware/common";
import {
  addKey,
  addAnthropicPreamble,
  createPreprocessorMiddleware,
  finalizeBody,
  createOnProxyReqHandler,
} from "./middleware/request";
import {
  ProxyResHandlerWithBody,
  createOnProxyResHandler,
} from "./middleware/response";
import { sendErrorToClient } from "./middleware/response/error-generator";

let modelsCache: any = null;
let modelsCacheTime = 0;

const getModelsResponse = () => {
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
    "claude-2",
    "claude-2.0",
    "claude-2.1",
    "claude-3-haiku-20240307",
    "claude-3-opus-20240229",
    "claude-3-sonnet-20240229",
    "claude-3-5-sonnet-20240620"
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
};

const handleModelRequest: RequestHandler = (_req, res) => {
  res.status(200).json(getModelsResponse());
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

  let newBody = body;
  switch (`${req.inboundApi}<-${req.outboundApi}`) {
    case "openai<-anthropic-text":
      req.log.info("Transforming Anthropic Text back to OpenAI format");
      newBody = transformAnthropicTextResponseToOpenAI(body, req);
      break;
    case "openai<-anthropic-chat":
      req.log.info("Transforming Anthropic Chat back to OpenAI format");
      newBody = transformAnthropicChatResponseToOpenAI(body);
      break;
    case "anthropic-text<-anthropic-chat":
      req.log.info("Transforming Anthropic Chat back to Anthropic chat format");
      newBody = transformAnthropicChatResponseToAnthropicText(body);
      break;
  }

  res.status(200).json({ ...newBody, proxy: body.proxy });
};

function flattenChatResponse(
  content: { type: string; text: string }[]
): string {
  return content
    .map((part: { type: string; text: string }) =>
      part.type === "text" ? part.text : ""
    )
    .join("\n");
}

export function transformAnthropicChatResponseToAnthropicText(
  anthropicBody: Record<string, any>
): Record<string, any> {
  return {
    type: "completion",
    id: "ant-" + anthropicBody.id,
    completion: flattenChatResponse(anthropicBody.content),
    stop_reason: anthropicBody.stop_reason,
    stop: anthropicBody.stop_sequence,
    model: anthropicBody.model,
    usage: anthropicBody.usage,
  };
}

/**
 * Transforms a model response from the Anthropic API to match those from the
 * OpenAI API, for users using Claude via the OpenAI-compatible endpoint. This
 * is only used for non-streaming requests as streaming requests are handled
 * on-the-fly.
 */
function transformAnthropicTextResponseToOpenAI(
  anthropicBody: Record<string, any>,
  req: Request
): Record<string, any> {
  const totalTokens = (req.promptTokens ?? 0) + (req.outputTokens ?? 0);
  return {
    id: "ant-" + anthropicBody.log_id,
    object: "chat.completion",
    created: Date.now(),
    model: anthropicBody.model,
    usage: {
      prompt_tokens: req.promptTokens,
      completion_tokens: req.outputTokens,
      total_tokens: totalTokens,
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

export function transformAnthropicChatResponseToOpenAI(
  anthropicBody: Record<string, any>
): Record<string, any> {
  return {
    id: "ant-" + anthropicBody.id,
    object: "chat.completion",
    created: Date.now(),
    model: anthropicBody.model,
    usage: anthropicBody.usage,
    choices: [
      {
        message: {
          role: "assistant",
          content: flattenChatResponse(anthropicBody.content),
        },
        finish_reason: anthropicBody.stop_reason,
        index: 0,
      },
    ],
  };
}

const anthropicProxy = createQueueMiddleware({
  proxyMiddleware: createProxyMiddleware({
    target: "https://api.anthropic.com",
    changeOrigin: true,
    selfHandleResponse: true,
    logger,
    on: {
      proxyReq: createOnProxyReqHandler({
        pipeline: [addKey, addAnthropicPreamble, finalizeBody],
      }),
      proxyRes: createOnProxyResHandler([anthropicResponseHandler]),
      error: handleProxyError,
    },
    // Abusing pathFilter to rewrite the paths dynamically.
    pathFilter: (pathname, req) => {
      const isText = req.outboundApi === "anthropic-text";
      const isChat = req.outboundApi === "anthropic-chat";
      if (isChat && pathname === "/v1/complete") {
        req.url = "/v1/messages";
      }
      if (isText && pathname === "/v1/chat/completions") {
        req.url = "/v1/complete";
      }
      if (isChat && pathname === "/v1/chat/completions") {
        req.url = "/v1/messages";
      }
      if (isChat && ["sonnet", "opus"].includes(req.params.type)) {
        req.url = "/v1/messages";
      }
      return true;
    },
  }),
});

const nativeTextPreprocessor = createPreprocessorMiddleware({
  inApi: "anthropic-text",
  outApi: "anthropic-text",
  service: "anthropic",
});

const textToChatPreprocessor = createPreprocessorMiddleware({
  inApi: "anthropic-text",
  outApi: "anthropic-chat",
  service: "anthropic",
});

/**
 * Routes text completion prompts to anthropic-chat if they need translation
 * (claude-3 based models do not support the old text completion endpoint).
 */
const preprocessAnthropicTextRequest: RequestHandler = (req, res, next) => {
  if (req.body.model?.startsWith("claude-3")) {
    textToChatPreprocessor(req, res, next);
  } else {
    nativeTextPreprocessor(req, res, next);
  }
};

const oaiToTextPreprocessor = createPreprocessorMiddleware({
  inApi: "openai",
  outApi: "anthropic-text",
  service: "anthropic",
});

const oaiToChatPreprocessor = createPreprocessorMiddleware({
  inApi: "openai",
  outApi: "anthropic-chat",
  service: "anthropic",
});

/**
 * Routes an OpenAI prompt to either the legacy Claude text completion endpoint
 * or the new Claude chat completion endpoint, based on the requested model.
 */
const preprocessOpenAICompatRequest: RequestHandler = (req, res, next) => {
  maybeReassignModel(req);
  if (req.body.model?.includes("claude-3")) {
    oaiToChatPreprocessor(req, res, next);
  } else {
    oaiToTextPreprocessor(req, res, next);
  }
};

const anthropicRouter = Router();
anthropicRouter.get("/v1/models", handleModelRequest);
// Native Anthropic chat completion endpoint.
anthropicRouter.post(
  "/v1/messages",
  ipLimiter,
  createPreprocessorMiddleware({
    inApi: "anthropic-chat",
    outApi: "anthropic-chat",
    service: "anthropic",
  }),
  anthropicProxy
);
// Anthropic text completion endpoint. Translates to Anthropic chat completion
// if the requested model is a Claude 3 model.
anthropicRouter.post(
  "/v1/complete",
  ipLimiter,
  preprocessAnthropicTextRequest,
  anthropicProxy
);
// OpenAI-to-Anthropic compatibility endpoint. Accepts an OpenAI chat completion
// request and transforms/routes it to the appropriate Anthropic format and
// endpoint based on the requested model.
anthropicRouter.post(
  "/v1/chat/completions",
  ipLimiter,
  preprocessOpenAICompatRequest,
  anthropicProxy
);
// Temporarily force Anthropic Text to Anthropic Chat for frontends which do not
// yet support the new model. Forces claude-3. Will be removed once common
// frontends have been updated.
anthropicRouter.post(
  "/v1/:type(sonnet|opus)/:action(complete|messages)",
  ipLimiter,
  handleAnthropicTextCompatRequest,
  createPreprocessorMiddleware({
    inApi: "anthropic-text",
    outApi: "anthropic-chat",
    service: "anthropic",
  }),
  anthropicProxy
);

function handleAnthropicTextCompatRequest(
  req: Request,
  res: Response,
  next: any
) {
  const type = req.params.type;
  const action = req.params.action;
  const alreadyInChatFormat = Boolean(req.body.messages);
  const compatModel = `claude-3-${type}-20240229`;
  req.log.info(
    { type, inputModel: req.body.model, compatModel, alreadyInChatFormat },
    "Handling Anthropic compatibility request"
  );

  if (action === "messages" || alreadyInChatFormat) {
    return sendErrorToClient({
      req,
      res,
      options: {
        title: "Unnecessary usage of compatibility endpoint",
        message: `Your client seems to already support the new Claude API format. This endpoint is intended for clients that do not yet support the new format.\nUse the normal \`/anthropic\` proxy endpoint instead.`,
        format: "unknown",
        statusCode: 400,
        reqId: req.id,
        obj: {
          requested_endpoint: "/anthropic/" + type,
          correct_endpoint: "/anthropic",
        },
      },
    });
  }

  req.body.model = compatModel;
  next();
}

/**
 * If a client using the OpenAI compatibility endpoint requests an actual OpenAI
 * model, reassigns it to Claude 3 Sonnet.
 */
function maybeReassignModel(req: Request) {
  const model = req.body.model;
  if (!model.startsWith("gpt-")) return;
  req.body.model = "claude-3-sonnet-20240229";
}

export const anthropic = anthropicRouter;
