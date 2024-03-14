import { Request, RequestHandler, Router } from "express";
import { createProxyMiddleware } from "http-proxy-middleware";
import { v4 } from "uuid";
import { config } from "../config";
import { logger } from "../logger";
import { createQueueMiddleware } from "./queue";
import { ipLimiter } from "./rate-limit";
import { handleProxyError } from "./middleware/common";
import {
  createOnProxyReqHandler,
  createPreprocessorMiddleware,
  finalizeSignedRequest,
} from "./middleware/request";
import {
  createOnProxyResHandler,
  ProxyResHandlerWithBody,
} from "./middleware/response";
import { addGoogleAIKey } from "./middleware/request/preprocessors/add-google-ai-key";

let modelsCache: any = null;
let modelsCacheTime = 0;

// https://ai.google.dev/models/gemini
// TODO: list models https://ai.google.dev/tutorials/rest_quickstart#list_models

const getModelsResponse = () => {
  if (new Date().getTime() - modelsCacheTime < 1000 * 60) {
    return modelsCache;
  }

  if (!config.googleAIKey) return { object: "list", data: [] };

  const googleAIVariants = ["gemini-pro", "gemini-1.0-pro", "gemini-1.5-pro"];

  const models = googleAIVariants.map((id) => ({
    id,
    object: "model",
    created: new Date().getTime(),
    owned_by: "google",
    permission: [],
    root: "google",
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
const googleAIResponseHandler: ProxyResHandlerWithBody = async (
  _proxyRes,
  req,
  res,
  body
) => {
  if (typeof body !== "object") {
    throw new Error("Expected body to be an object");
  }

  let newBody = body;
  if (req.inboundApi === "openai") {
    req.log.info("Transforming Google AI response to OpenAI format");
    newBody = transformGoogleAIResponse(body, req);
  }

  res.status(200).json({ ...newBody, proxy: body.proxy });
};

function transformGoogleAIResponse(
  resBody: Record<string, any>,
  req: Request
): Record<string, any> {
  const totalTokens = (req.promptTokens ?? 0) + (req.outputTokens ?? 0);
  const parts = resBody.candidates[0].content?.parts ?? [{ text: "" }];
  const content = parts[0].text.replace(/^(.{0,50}?): /, () => "");
  return {
    id: "goo-" + v4(),
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
        message: { role: "assistant", content },
        finish_reason: resBody.candidates[0].finishReason,
        index: 0,
      },
    ],
  };
}

const googleAIProxy = createQueueMiddleware({
  beforeProxy: addGoogleAIKey,
  proxyMiddleware: createProxyMiddleware({
    target: "bad-target-will-be-rewritten",
    router: ({ signedRequest }) => {
      const { protocol, hostname, path } = signedRequest;
      return `${protocol}//${hostname}${path}`;
    },
    changeOrigin: true,
    selfHandleResponse: true,
    logger,
    on: {
      proxyReq: createOnProxyReqHandler({ pipeline: [finalizeSignedRequest] }),
      proxyRes: createOnProxyResHandler([googleAIResponseHandler]),
      error: handleProxyError,
    },
  }),
});

const googleAIRouter = Router();
googleAIRouter.get("/v1/models", handleModelRequest);
// OpenAI-to-Google AI compatibility endpoint.
googleAIRouter.post(
  "/v1/chat/completions",
  ipLimiter,
  createPreprocessorMiddleware({
    inApi: "openai",
    outApi: "google-ai",
    service: "google-ai",
  }),
  googleAIProxy
);

export const googleAI = googleAIRouter;
