import { RequestHandler, Router, Request } from "express";
import { createProxyMiddleware } from "http-proxy-middleware";
import { config } from "../config";
import { logger } from "../logger";
import { createQueueMiddleware } from "./queue";
import { ipLimiter } from "./rate-limit";
import { handleProxyError } from "./middleware/common";
import {
  addKey,
  createPreprocessorMiddleware,
  finalizeBody,
  createOnProxyReqHandler,
} from "./middleware/request";
import {
  createOnProxyResHandler,
  ProxyResHandlerWithBody,
} from "./middleware/response";
import { generateModelList } from "./openai";
import {
  OpenAIImageGenerationResult,
} from "../shared/file-storage/mirror-generated-image";

const KNOWN_MODELS = ["dall-e-2", "dall-e-3"];

let modelListCache: any = null;
let modelListValid = 0;
const handleModelRequest: RequestHandler = (_req, res) => {
  if (new Date().getTime() - modelListValid < 1000 * 60) {
    return res.status(200).json(modelListCache);
  }
  const result = generateModelList(KNOWN_MODELS);
  modelListCache = { object: "list", data: result };
  modelListValid = new Date().getTime();
  res.status(200).json(modelListCache);
};

const openaiImagesResponseHandler: ProxyResHandlerWithBody = async (
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
    req.log.info("Transforming OpenAI image response to OpenAI chat format");
    body = transformResponseForChat(body as OpenAIImageGenerationResult, req);
  }

  if (req.tokenizerInfo) {
    body.proxy_tokenizer = req.tokenizerInfo;
  }

  res.status(200).json(body);
};

/**
 * Transforms a DALL-E image generation response into a chat response, simply
 * embedding the image URL into the chat message as a Markdown image.
 */
function transformResponseForChat(
  imageBody: OpenAIImageGenerationResult,
  req: Request
): Record<string, any> {
  const prompt = imageBody.data[0].revised_prompt ?? req.body.prompt;
  const content = imageBody.data
    .map((item) => {
      const { url, b64_json } = item;
      if (b64_json) {
        return `![${prompt}](data:image/png;base64,${b64_json})`;
      } else {
        return `![${prompt}](${url})`;
      }
    })
    .join("\n\n");

  return {
    id: "dalle-" + req.id,
    object: "chat.completion",
    created: Date.now(),
    model: req.body.model,
    usage: {
      prompt_tokens: 0,
      completion_tokens: req.outputTokens,
      total_tokens: req.outputTokens,
    },
    choices: [
      {
        message: { role: "assistant", content },
        finish_reason: "stop",
        index: 0,
      },
    ],
  };
}

const openaiImagesProxy = createQueueMiddleware({
  proxyMiddleware: createProxyMiddleware({
    target: "https://api.openai.com",
    changeOrigin: true,
    selfHandleResponse: true,
    logger,
    pathRewrite: {
      "^/v1/chat/completions": "/v1/images/generations",
    },
    on: {
      proxyReq: createOnProxyReqHandler({ pipeline: [addKey, finalizeBody] }),
      proxyRes: createOnProxyResHandler([openaiImagesResponseHandler]),
      error: handleProxyError,
    },
  }),
});

const openaiImagesRouter = Router();
openaiImagesRouter.get("/v1/models", handleModelRequest);
openaiImagesRouter.post(
  "/v1/images/generations",
  ipLimiter,
  createPreprocessorMiddleware({
    inApi: "openai-image",
    outApi: "openai-image",
    service: "openai",
  }),
  openaiImagesProxy
);
openaiImagesRouter.post(
  "/v1/chat/completions",
  ipLimiter,
  createPreprocessorMiddleware({
    inApi: "openai",
    outApi: "openai-image",
    service: "openai",
  }),
  openaiImagesProxy
);
export const openaiImage = openaiImagesRouter;
