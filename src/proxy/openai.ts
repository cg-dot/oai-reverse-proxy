import { RequestHandler, Request, Router } from "express";
import * as http from "http";
import { createProxyMiddleware } from "http-proxy-middleware";
import { config } from "../config";
import { keyPool } from "../key-management";
import { logger } from "../logger";
import { createQueueMiddleware } from "./queue";
import { ipLimiter } from "./rate-limit";
import { handleProxyError } from "./middleware/common";
import {
  addKey,
  blockZoomerOrigins,
  createPreprocessorMiddleware,
  finalizeBody,
  languageFilter,
  limitCompletions,
  limitOutputTokens,
  removeOriginHeaders,
} from "./middleware/request";
import {
  createOnProxyResHandler,
  ProxyResHandlerWithBody,
} from "./middleware/response";

let modelsCache: any = null;
let modelsCacheTime = 0;

function getModelsResponse() {
  if (new Date().getTime() - modelsCacheTime < 1000 * 60) {
    return modelsCache;
  }

  // https://platform.openai.com/docs/models/overview
  const gptVariants = [
    "gpt-4",
    "gpt-4-0613",
    "gpt-4-0314", // EOL 2023-09-13
    "gpt-4-32k",
    "gpt-4-32k-0613",
    "gpt-4-32k-0314", // EOL 2023-09-13
    "gpt-3.5-turbo",
    "gpt-3.5-turbo-0301", // EOL 2023-09-13
    "gpt-3.5-turbo-0613",
    "gpt-3.5-turbo-16k",
    "gpt-3.5-turbo-16k-0613",
  ];

  const gpt4Available = keyPool.list().filter((key) => {
    return key.service === "openai" && !key.isDisabled && key.isGpt4;
  }).length;

  const models = gptVariants
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
      if (model.id.startsWith("gpt-4")) {
        return gpt4Available > 0;
      }
      return true;
    });

  modelsCache = { object: "list", data: models };
  modelsCacheTime = new Date().getTime();

  return modelsCache;
}

const handleModelRequest: RequestHandler = (_req, res) => {
  res.status(200).json(getModelsResponse());
};

const rewriteRequest = (
  proxyReq: http.ClientRequest,
  req: Request,
  res: http.ServerResponse
) => {
  const rewriterPipeline = [
    addKey,
    languageFilter,
    limitOutputTokens,
    limitCompletions,
    blockZoomerOrigins,
    removeOriginHeaders,
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

const openaiProxy = createQueueMiddleware(
  createProxyMiddleware({
    target: "https://api.openai.com",
    changeOrigin: true,
    on: {
      proxyReq: rewriteRequest,
      proxyRes: createOnProxyResHandler([openaiResponseHandler]),
      error: handleProxyError,
    },
    selfHandleResponse: true,
    logger,
  })
);

const openaiRouter = Router();
// Fix paths because clients don't consistently use the /v1 prefix.
openaiRouter.use((req, _res, next) => {
  if (!req.path.startsWith("/v1/")) {
    req.url = `/v1${req.url}`;
  }
  next();
});
openaiRouter.get("/v1/models", handleModelRequest);
openaiRouter.post(
  "/v1/chat/completions",
  ipLimiter,
  createPreprocessorMiddleware({ inApi: "openai", outApi: "openai" }),
  openaiProxy
);
// Redirect browser requests to the homepage.
openaiRouter.get("*", (req, res, next) => {
  const isBrowser = req.headers["user-agent"]?.includes("Mozilla");
  if (isBrowser) {
    res.redirect("/");
  } else {
    next();
  }
});
openaiRouter.use((req, res) => {
  req.log.warn(`Blocked openai proxy request: ${req.method} ${req.path}`);
  res.status(404).json({ error: "Not found" });
});

export const openai = openaiRouter;
