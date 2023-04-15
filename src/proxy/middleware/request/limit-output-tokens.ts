import { config } from "../../../config";
import { logger } from "../../../logger";
import type { ExpressHttpProxyReqCallback } from ".";

const MAX_TOKENS = config.maxOutputTokens;

/** Enforce a maximum number of tokens requested from OpenAI. */
export const limitOutputTokens: ExpressHttpProxyReqCallback = (
  _proxyReq,
  req
) => {
  if (req.method === "POST" && req.body?.max_tokens) {
    // convert bad or missing input to a MAX_TOKENS
    if (typeof req.body.max_tokens !== "number") {
      logger.warn(
        `Invalid max_tokens value: ${req.body.max_tokens}. Using ${MAX_TOKENS}`
      );
      req.body.max_tokens = MAX_TOKENS;
    }

    const originalTokens = req.body.max_tokens;
    req.body.max_tokens = Math.min(req.body.max_tokens, MAX_TOKENS);
    if (originalTokens !== req.body.max_tokens) {
      logger.warn(
        `Limiting max_tokens from ${originalTokens} to ${req.body.max_tokens}`
      );
    }
  }
};
