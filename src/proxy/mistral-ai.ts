import { RequestHandler, Router } from "express";
import { createProxyMiddleware } from "http-proxy-middleware";
import { config } from "../config";
import { keyPool } from "../shared/key-management";
import {
  getMistralAIModelFamily,
  MistralAIModelFamily,
  ModelFamily,
} from "../shared/models";
import { logger } from "../logger";
import { createQueueMiddleware } from "./queue";
import { ipLimiter } from "./rate-limit";
import { handleProxyError } from "./middleware/common";
import {
  addKey,
  createOnProxyReqHandler,
  createPreprocessorMiddleware,
  finalizeBody,
} from "./middleware/request";
import {
  createOnProxyResHandler,
  ProxyResHandlerWithBody,
} from "./middleware/response";

// https://docs.mistral.ai/platform/endpoints
export const KNOWN_MISTRAL_AI_MODELS = [
  "mistral-tiny",
  "mistral-small",
  "mistral-medium",
];

let modelsCache: any = null;
let modelsCacheTime = 0;

export function generateModelList(models = KNOWN_MISTRAL_AI_MODELS) {
  let available = new Set<MistralAIModelFamily>();
  for (const key of keyPool.list()) {
    if (key.isDisabled || key.service !== "mistral-ai") continue;
    key.modelFamilies.forEach((family) =>
      available.add(family as MistralAIModelFamily)
    );
  }
  const allowed = new Set<ModelFamily>(config.allowedModelFamilies);
  available = new Set([...available].filter((x) => allowed.has(x)));

  return models
    .map((id) => ({
      id,
      object: "model",
      created: new Date().getTime(),
      owned_by: "mistral-ai",
    }))
    .filter((model) => available.has(getMistralAIModelFamily(model.id)));
}

const handleModelRequest: RequestHandler = (_req, res) => {
  if (new Date().getTime() - modelsCacheTime < 1000 * 60){
    return res.status(200).json(modelsCache);
  }
  const result = generateModelList();
  modelsCache = { object: "list", data: result };
  modelsCacheTime = new Date().getTime();
  res.status(200).json(modelsCache);
};

const mistralAIResponseHandler: ProxyResHandlerWithBody = async (
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

  if (req.tokenizerInfo) {
    body.proxy_tokenizer = req.tokenizerInfo;
  }

  res.status(200).json(body);
};

const mistralAIProxy = createQueueMiddleware({
  proxyMiddleware: createProxyMiddleware({
    target: "https://api.mistral.ai",
    changeOrigin: true,
    selfHandleResponse: true,
    logger,
    on: {
      proxyReq: createOnProxyReqHandler({
        pipeline: [addKey, finalizeBody],
      }),
      proxyRes: createOnProxyResHandler([mistralAIResponseHandler]),
      error: handleProxyError,
    },
  }),
});

const mistralAIRouter = Router();
mistralAIRouter.get("/v1/models", handleModelRequest);
// General chat completion endpoint.
mistralAIRouter.post(
  "/v1/chat/completions",
  ipLimiter,
  createPreprocessorMiddleware({
    inApi: "mistral-ai",
    outApi: "mistral-ai",
    service: "mistral-ai",
  }),
  mistralAIProxy
);

export const mistralAI = mistralAIRouter;
