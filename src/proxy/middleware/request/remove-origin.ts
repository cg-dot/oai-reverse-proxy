import { ProxyRequestMiddleware } from ".";

/**
 * Removes origin and referer headers before sending the request to the API for
 * privacy reasons.
 **/
export const removeOrigin: ProxyRequestMiddleware = (proxyReq) => {
  proxyReq.setHeader("origin", "");
  proxyReq.setHeader("referer", "");
};
