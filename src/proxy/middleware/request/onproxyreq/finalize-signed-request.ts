import type { HPMRequestCallback } from "../index";

/**
 * For AWS/Azure/Google requests, the body is signed earlier in the request
 * pipeline, before the proxy middleware. This function just assigns the path
 * and headers to the proxy request.
 */
export const finalizeSignedRequest: HPMRequestCallback = (proxyReq, req) => {
  if (!req.signedRequest) {
    throw new Error("Expected req.signedRequest to be set");
  }

  // The path depends on the selected model and the assigned key's region.
  proxyReq.path = req.signedRequest.path;

  // Amazon doesn't want extra headers, so we need to remove all of them and
  // reassign only the ones specified in the signed request.
  proxyReq.getRawHeaderNames().forEach(proxyReq.removeHeader.bind(proxyReq));
  Object.entries(req.signedRequest.headers).forEach(([key, value]) => {
    proxyReq.setHeader(key, value);
  });

  // Don't use fixRequestBody here because it adds a content-length header.
  // Amazon doesn't want that and it breaks the signature.
  proxyReq.write(req.signedRequest.body);
};
