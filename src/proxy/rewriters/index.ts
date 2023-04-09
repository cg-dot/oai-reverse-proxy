import type { Request } from "express";
import type { ClientRequest } from "http";
import type { ProxyReqCallback } from "http-proxy";

export { addKey } from "./add-key";
export { languageFilter } from "./language-filter";
export { disableStream } from "./disable-stream";
export { limitOutputTokens } from "./limit-output-tokens";
export { finalizeBody } from "./finalize-body";

export type ExpressHttpProxyReqCallback = ProxyReqCallback<
  ClientRequest,
  Request
>;
