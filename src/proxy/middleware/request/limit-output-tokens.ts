import { Request } from "express";
import { config } from "../../../config";
import { ExpressHttpProxyReqCallback, isCompletionRequest } from ".";

const MAX_TOKENS = config.maxOutputTokens;

/** Enforce a maximum number of tokens requested from the model. */
export const limitOutputTokens: ExpressHttpProxyReqCallback = (
  _proxyReq,
  req
) => {
  if (isCompletionRequest(req) && req.body?.max_tokens) {
    const requestedMaxTokens = Number.parseInt(getMaxTokensFromRequest(req));
    let maxTokens = requestedMaxTokens;

    if (typeof requestedMaxTokens !== "number") {
      req.log.warn(
        { requestedMaxTokens, clampedMaxTokens: MAX_TOKENS },
        "Invalid max tokens value. Using default value."
      );
      maxTokens = MAX_TOKENS;
    }

    // TODO: this is not going to scale well, need to implement a better way
    // of translating request parameters from one API to another.
    maxTokens = Math.min(maxTokens, MAX_TOKENS);
    if (req.outboundApi === "openai") {
      req.body.max_tokens = maxTokens;
    } else if (req.outboundApi === "anthropic") {
      req.body.max_tokens_to_sample = maxTokens;
    }

    if (requestedMaxTokens !== maxTokens) {
      req.log.warn(
        `Limiting max tokens from ${requestedMaxTokens} to ${maxTokens}`
      );
    }
  }
};

function getMaxTokensFromRequest(req: Request) {
  return (req.body?.max_tokens || req.body?.max_tokens_to_sample) ?? MAX_TOKENS;
}
