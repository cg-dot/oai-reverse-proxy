import { RequestHandler, Router } from "express";
import { createProxyMiddleware } from "http-proxy-middleware";
import { config } from "../config";
import { keyPool, OpenAIKey } from "../shared/key-management";
import {
  getOpenAIModelFamily,
  ModelFamily,
  OpenAIModelFamily,
} from "../shared/models";
import { logger } from "../logger";
import { createQueueMiddleware } from "./queue";
import { ipLimiter } from "./rate-limit";
import { handleProxyError } from "./middleware/common";
import {
  addKey,
  addKeyForEmbeddingsRequest,
  createEmbeddingsPreprocessorMiddleware,
  createOnProxyReqHandler,
  createPreprocessorMiddleware,
  finalizeBody,
  forceModel,
  RequestPreprocessor,
} from "./middleware/request";
import {
  createOnProxyResHandler,
  ProxyResHandlerWithBody,
} from "./middleware/response";

// https://platform.openai.com/docs/models/overview
export const KNOWN_OPENAI_MODELS = [
  "gpt-4-turbo-preview",
  "gpt-4-0125-preview",
  "gpt-4-1106-preview",
  "gpt-4-vision-preview",
  "gpt-4",
  "gpt-4-0613",
  "gpt-4-0314", // EOL 2024-06-13
  "gpt-4-32k",
  "gpt-4-32k-0314", // EOL 2024-06-13
  "gpt-4-32k-0613",
  "gpt-3.5-turbo",
  "gpt-3.5-turbo-0301", // EOL 2024-06-13
  "gpt-3.5-turbo-0613",
  "gpt-3.5-turbo-16k",
  "gpt-3.5-turbo-16k-0613",
  "gpt-3.5-turbo-instruct",
  "gpt-3.5-turbo-instruct-0914",
  "text-embedding-ada-002",
];

let modelsCache: any = null;
let modelsCacheTime = 0;

export function generateModelList(models = KNOWN_OPENAI_MODELS) {
  // Get available families and snapshots
  let availableFamilies = new Set<OpenAIModelFamily>();
  const availableSnapshots = new Set<string>();
  for (const key of keyPool.list()) {
    if (key.isDisabled || key.service !== "openai") continue;
    const asOpenAIKey = key as OpenAIKey;
    asOpenAIKey.modelFamilies.forEach((f) => availableFamilies.add(f));
    asOpenAIKey.modelSnapshots.forEach((s) => availableSnapshots.add(s));
  }

  // Remove disabled families
  const allowed = new Set<ModelFamily>(config.allowedModelFamilies);
  availableFamilies = new Set(
    [...availableFamilies].filter((x) => allowed.has(x))
  );

  return models
    .map((id) => ({
      id,
      object: "model",
      created: new Date().getTime(),
      owned_by: "openai",
      permission: [
        {
          id: "modelperm-" + id,
          object: "model_permission",
          created: new Date().getTime(),
          organization: "*",
          group: null,
          is_blocking: false,
        },
      ],
      root: id,
      parent: null,
    }))
    .filter((model) => {
      // First check if the family is available
      const hasFamily = availableFamilies.has(getOpenAIModelFamily(model.id));
      if (!hasFamily) return false;

      // Then for snapshots, ensure the specific snapshot is available
      const isSnapshot = model.id.match(/-\d{4}(-preview)?$/);
      if (!isSnapshot) return true;
      return availableSnapshots.has(model.id);
    });
}

const handleModelRequest: RequestHandler = (_req, res) => {
  if (new Date().getTime() - modelsCacheTime < 1000 * 60) {
    return res.status(200).json(modelsCache);
  }
  const result = generateModelList();
  modelsCache = { object: "list", data: result };
  modelsCacheTime = new Date().getTime();
  res.status(200).json(modelsCache);
};

/** Handles some turbo-instruct special cases. */
const rewriteForTurboInstruct: RequestPreprocessor = (req) => {
  // /v1/turbo-instruct/v1/chat/completions accepts either prompt or messages.
  // Depending on whichever is provided, we need to set the inbound format so
  // it is transformed correctly later.
  if (req.body.prompt && !req.body.messages) {
    req.inboundApi = "openai-text";
  } else if (req.body.messages && !req.body.prompt) {
    req.inboundApi = "openai";
    // Set model for user since they're using a client which is not aware of
    // turbo-instruct.
    req.body.model = "gpt-3.5-turbo-instruct";
  } else {
    throw new Error("`prompt` OR `messages` must be provided");
  }

  req.url = "/v1/completions";
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

  let newBody = body;
  if (req.outboundApi === "openai-text" && req.inboundApi === "openai") {
    req.log.info("Transforming Turbo-Instruct response to Chat format");
    newBody = transformTurboInstructResponse(body);
  }

  res.status(200).json({ ...newBody, proxy: body.proxy });
};

/** Only used for non-streaming responses. */
function transformTurboInstructResponse(
  turboInstructBody: Record<string, any>
): Record<string, any> {
  const transformed = { ...turboInstructBody };
  transformed.choices = [
    {
      ...turboInstructBody.choices[0],
      message: {
        role: "assistant",
        content: turboInstructBody.choices[0].text.trim(),
      },
    },
  ];
  delete transformed.choices[0].text;
  return transformed;
}

const openaiProxy = createQueueMiddleware({
  proxyMiddleware: createProxyMiddleware({
    target: "https://api.openai.com",
    changeOrigin: true,
    selfHandleResponse: true,
    logger,
    on: {
      proxyReq: createOnProxyReqHandler({ pipeline: [addKey, finalizeBody] }),
      proxyRes: createOnProxyResHandler([openaiResponseHandler]),
      error: handleProxyError,
    },
  }),
});

const openaiEmbeddingsProxy = createProxyMiddleware({
  target: "https://api.openai.com",
  changeOrigin: true,
  selfHandleResponse: false,
  logger,
  on: {
    proxyReq: createOnProxyReqHandler({
      pipeline: [addKeyForEmbeddingsRequest, finalizeBody],
    }),
    error: handleProxyError,
  },
});

const openaiRouter = Router();
openaiRouter.get("/v1/models", handleModelRequest);
// Native text completion endpoint, only for turbo-instruct.
openaiRouter.post(
  "/v1/completions",
  ipLimiter,
  createPreprocessorMiddleware({
    inApi: "openai-text",
    outApi: "openai-text",
    service: "openai",
  }),
  openaiProxy
);
// turbo-instruct compatibility endpoint, accepts either prompt or messages
openaiRouter.post(
  /\/v1\/turbo-instruct\/(v1\/)?chat\/completions/,
  ipLimiter,
  createPreprocessorMiddleware(
    { inApi: "openai", outApi: "openai-text", service: "openai" },
    {
      beforeTransform: [rewriteForTurboInstruct],
      afterTransform: [forceModel("gpt-3.5-turbo-instruct")],
    }
  ),
  openaiProxy
);
// General chat completion endpoint. Turbo-instruct is not supported here.
openaiRouter.post(
  "/v1/chat/completions",
  ipLimiter,
  createPreprocessorMiddleware({
    inApi: "openai",
    outApi: "openai",
    service: "openai",
  }),
  openaiProxy
);
// Embeddings endpoint.
openaiRouter.post(
  "/v1/embeddings",
  ipLimiter,
  createEmbeddingsPreprocessorMiddleware(),
  openaiEmbeddingsProxy
);

export const openai = openaiRouter;
