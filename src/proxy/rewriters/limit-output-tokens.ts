import { config } from "../../config";
import type { ExpressHttpProxyReqCallback } from ".";
import { logger } from "../../logger";

const MAX_TOKENS = config.maxOutputTokens;

/** Enforce a maximum number of tokens requested from OpenAI. */
export const limitOutputTokens: ExpressHttpProxyReqCallback = (
  _proxyReq,
  req
) => {
  if (req.method === "POST" && req.body?.max_tokens) {
    const originalTokens = req.body.max_tokens;
    req.body.max_tokens = Math.min(req.body.max_tokens, MAX_TOKENS);
    if (originalTokens !== req.body.max_tokens) {
      logger.warn(
        `Limiting max_tokens from ${originalTokens} to ${req.body.max_tokens}`
      );
    }
  }
};
