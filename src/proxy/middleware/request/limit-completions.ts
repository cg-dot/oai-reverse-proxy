import { ExpressHttpProxyReqCallback, isCompletionRequest } from ".";

/**
 * Don't allow multiple completions to be requested to prevent abuse.
 * OpenAI-only, Anthropic provides no such parameter.
 **/
export const limitCompletions: ExpressHttpProxyReqCallback = (
  _proxyReq,
  req
) => {
  if (isCompletionRequest(req)) {
    const originalN = req.body?.n || 1;
    req.body.n = 1;
    if (originalN !== req.body.n) {
      req.log.warn(`Limiting completion choices from ${originalN} to 1`);
    }
  }
};
