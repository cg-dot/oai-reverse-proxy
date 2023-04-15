import type { Request } from "express";
import type { ClientRequest } from "http";
import type { ProxyReqCallback } from "http-proxy";

export { addKey } from "./add-key";
export { disableStream } from "./disable-stream";
export { finalizeBody } from "./finalize-body";
export { languageFilter } from "./language-filter";
export { limitCompletions } from "./limit-completions";
export { limitOutputTokens } from "./limit-output-tokens";
export { transformKoboldPayload } from "./transform-kobold-payload";

export type ExpressHttpProxyReqCallback = ProxyReqCallback<
  ClientRequest,
  Request
>;
