import type { Request } from "express";
import type { ClientRequest } from "http";
import type { ProxyReqCallback } from "http-proxy";

export { createOnProxyReqHandler } from "./onproxyreq-factory";
export {
  createPreprocessorMiddleware,
  createEmbeddingsPreprocessorMiddleware,
} from "./preprocessor-factory";

// Express middleware (runs before http-proxy-middleware, can be async)
export { addAzureKey } from "./preprocessors/add-azure-key";
export { applyQuotaLimits } from "./preprocessors/apply-quota-limits";
export { countPromptTokens } from "./preprocessors/count-prompt-tokens";
export { languageFilter } from "./preprocessors/language-filter";
export { setApiFormat } from "./preprocessors/set-api-format";
export { signAwsRequest } from "./preprocessors/sign-aws-request";
export { transformOutboundPayload } from "./preprocessors/transform-outbound-payload";
export { validateContextSize } from "./preprocessors/validate-context-size";
export { validateVision } from "./preprocessors/validate-vision";

// http-proxy-middleware callbacks (runs on onProxyReq, cannot be async)
export { addAnthropicPreamble } from "./onproxyreq/add-anthropic-preamble";
export { addKey, addKeyForEmbeddingsRequest } from "./onproxyreq/add-key";
export { blockZoomerOrigins } from "./onproxyreq/block-zoomer-origins";
export { checkModelFamily } from "./onproxyreq/check-model-family";
export { finalizeBody } from "./onproxyreq/finalize-body";
export { finalizeSignedRequest } from "./onproxyreq/finalize-signed-request";
export { stripHeaders } from "./onproxyreq/strip-headers";

/**
 * Middleware that runs prior to the request being handled by http-proxy-
 * middleware.
 *
 * Async functions can be used here, but you will not have access to the proxied
 * request/response objects, nor the data set by ProxyRequestMiddleware
 * functions as they have not yet been run.
 *
 * User will have been authenticated by the time this middleware runs, but your
 * request won't have been assigned an API key yet.
 *
 * Note that these functions only run once ever per request, even if the request
 * is automatically retried by the request queue middleware.
 */
export type RequestPreprocessor = (req: Request) => void | Promise<void>;

/**
 * Callbacks that run immediately before the request is sent to the API in
 * response to http-proxy-middleware's `proxyReq` event.
 *
 * Async functions cannot be used here as HPM's event emitter is not async and
 * will not wait for the promise to resolve before sending the request.
 *
 * Note that these functions may be run multiple times per request if the
 * first attempt is rate limited and the request is automatically retried by the
 * request queue middleware.
 */
export type HPMRequestCallback = ProxyReqCallback<ClientRequest, Request>;

export const forceModel = (model: string) => (req: Request) =>
  void (req.body.model = model);
