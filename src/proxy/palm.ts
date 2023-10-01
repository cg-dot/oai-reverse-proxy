import { Request, RequestHandler, Router } from "express";
import * as http from "http";
import { createProxyMiddleware } from "http-proxy-middleware";
import { v4 } from "uuid";
import { config } from "../config";
import { logger } from "../logger";
import { createQueueMiddleware } from "./queue";
import { ipLimiter } from "./rate-limit";
import { handleProxyError } from "./middleware/common";
import {
  addKey,
  applyQuotaLimits,
  blockZoomerOrigins,
  createOnProxyReqHandler,
  createPreprocessorMiddleware,
  finalizeBody,
  forceModel,
  languageFilter,
  stripHeaders,
} from "./middleware/request";
import {
  createOnProxyResHandler,
  ProxyResHandlerWithBody,
} from "./middleware/response";

let modelsCache: any = null;
let modelsCacheTime = 0;

const getModelsResponse = () => {
  if (new Date().getTime() - modelsCacheTime < 1000 * 60) {
    return modelsCache;
  }

  if (!config.googlePalmKey) return { object: "list", data: [] };

  const bisonVariants = ["text-bison-001"];

  const models = bisonVariants.map((id) => ({
    id,
    object: "model",
    created: new Date().getTime(),
    owned_by: "google",
    permission: [],
    root: "palm",
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
const palmResponseHandler: ProxyResHandlerWithBody = async (
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
    req.log.info("Transforming Google PaLM response to OpenAI format");
    body = transformPalmResponse(body, req);
  }

  // TODO: Remove once tokenization is stable
  if (req.debug) {
    body.proxy_tokenizer_debug_info = req.debug;
  }

  // TODO: PaLM has no streaming capability which will pose a problem here if
  // requests wait in the queue for too long.  Probably need to fake streaming
  // and return the entire completion in one stream event using the other
  // response handler.
  res.status(200).json(body);
};

/**
 * Transforms a model response from the Anthropic API to match those from the
 * OpenAI API, for users using Claude via the OpenAI-compatible endpoint. This
 * is only used for non-streaming requests as streaming requests are handled
 * on-the-fly.
 */
function transformPalmResponse(
  palmRespBody: Record<string, any>,
  req: Request
): Record<string, any> {
  const totalTokens = (req.promptTokens ?? 0) + (req.outputTokens ?? 0);
  return {
    id: "plm-" + v4(),
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
          content: palmRespBody.candidates[0].output,
        },
        finish_reason: null, // palm doesn't return this
        index: 0,
      },
    ],
  };
}

function reassignPathForPalmModel(proxyReq: http.ClientRequest, req: Request) {
  if (req.body.stream) {
    throw new Error("Google PaLM API doesn't support streaming requests");
  }

  // PaLM API specifies the model in the URL path, not the request body. This
  // doesn't work well with our rewriter architecture, so we need to manually
  // fix it here.

  // POST https://generativelanguage.googleapis.com/v1beta2/{model=models/*}:generateText
  // POST https://generativelanguage.googleapis.com/v1beta2/{model=models/*}:generateMessage

  // The chat api (generateMessage) is not very useful at this time as it has
  // few params and no adjustable safety settings.

  proxyReq.path = proxyReq.path.replace(
    /^\/v1\/chat\/completions/,
    `/v1beta2/models/${req.body.model}:generateText`
  );
}

const googlePalmProxy = createQueueMiddleware(
  createProxyMiddleware({
    target: "https://generativelanguage.googleapis.com",
    changeOrigin: true,
    selfHandleResponse: true,
    logger,
    on: {
      proxyReq: createOnProxyReqHandler({
        beforeRewrite: [reassignPathForPalmModel],
        pipeline: [
          applyQuotaLimits,
          addKey,
          languageFilter,
          blockZoomerOrigins,
          stripHeaders,
          finalizeBody,
        ],
      }),
      proxyRes: createOnProxyResHandler([palmResponseHandler]),
      error: handleProxyError,
    },
  })
);

const palmRouter = Router();
palmRouter.get("/v1/models", handleModelRequest);
// OpenAI-to-Google PaLM compatibility endpoint.
palmRouter.post(
  "/v1/chat/completions",
  ipLimiter,
  createPreprocessorMiddleware(
    { inApi: "openai", outApi: "google-palm", service: "google-palm" },
    { afterTransform: [forceModel("text-bison-001")] }
  ),
  googlePalmProxy
);

export const googlePalm = palmRouter;
