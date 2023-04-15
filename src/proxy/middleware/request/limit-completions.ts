import type { ExpressHttpProxyReqCallback } from ".";

const OPENAI_CHAT_COMPLETION_ENDPOINT = "/v1/chat/completions";

/** Don't allow multiple completions to be requested to prevent abuse. */
export const limitCompletions: ExpressHttpProxyReqCallback = (
  _proxyReq,
  req
) => {
  if (req.method === "POST" && req.path === OPENAI_CHAT_COMPLETION_ENDPOINT) {
    const originalN = req.body?.n || 1;
    req.body.n = 1;
    if (originalN !== req.body.n) {
      req.log.warn(`Limiting completion choices from ${originalN} to 1`);
    }
  }
};
