import type { ExpressHttpProxyReqCallback } from ".";

/** Disable token streaming as the proxy middleware doesn't support it. */
export const disableStream: ExpressHttpProxyReqCallback = (_proxyReq, req) => {
  if (req.method === "POST" && req.body && req.body.stream) {
    req.body.stream = false;
  }
};
