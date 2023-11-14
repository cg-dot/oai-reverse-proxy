import { isTextGenerationRequest } from "../common";
import { ProxyRequestMiddleware } from ".";

/**
 * Don't allow multiple text completions to be requested to prevent abuse.
 * OpenAI-only, Anthropic provides no such parameter.
 **/
export const limitCompletions: ProxyRequestMiddleware = (_proxyReq, req) => {
  if (isTextGenerationRequest(req) && req.outboundApi === "openai") {
    const originalN = req.body?.n || 1;
    req.body.n = 1;
    if (originalN !== req.body.n) {
      req.log.warn(`Limiting completion choices from ${originalN} to 1`);
    }
  }
};
