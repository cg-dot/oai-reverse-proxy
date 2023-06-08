import { Request } from "express";
import { config } from "../../../config";
import { isCompletionRequest } from "../common";
import { ProxyRequestMiddleware } from ".";

/** Enforce a maximum number of tokens requested from the model. */
export const limitOutputTokens: ProxyRequestMiddleware = (_proxyReq, req) => {
  // TODO: do all of this shit in the zod validator
  if (isCompletionRequest(req)) {
    const requestedMax = Number.parseInt(getMaxTokensFromRequest(req));
    const apiMax =
      req.outboundApi === "openai"
        ? config.maxOutputTokensOpenAI
        : config.maxOutputTokensAnthropic;
    let maxTokens = requestedMax;

    if (typeof requestedMax !== "number") {
      maxTokens = apiMax;
    }

    maxTokens = Math.min(maxTokens, apiMax);
    if (req.outboundApi === "openai") {
      req.body.max_tokens = maxTokens;
    } else if (req.outboundApi === "anthropic") {
      req.body.max_tokens_to_sample = maxTokens;
    }

    if (requestedMax !== maxTokens) {
      req.log.info(
        { requestedMax, configMax: apiMax, final: maxTokens },
        "Limiting user's requested max output tokens"
      );
    }
  }
};

function getMaxTokensFromRequest(req: Request) {
  switch (req.outboundApi) {
    case "anthropic":
      return req.body?.max_tokens_to_sample;
    case "openai":
      return req.body?.max_tokens;
    default:
      throw new Error(`Unknown service: ${req.outboundApi}`);
  }
}
