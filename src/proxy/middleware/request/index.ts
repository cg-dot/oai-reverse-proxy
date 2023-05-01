import type { Request } from "express";
import type { ClientRequest } from "http";
import type { ProxyReqCallback } from "http-proxy";

export { addKey } from "./add-key";
export { checkStreaming } from "./check-streaming";
export { finalizeBody } from "./finalize-body";
export { languageFilter } from "./language-filter";
export { limitCompletions } from "./limit-completions";
export { limitOutputTokens } from "./limit-output-tokens";
export { transformKoboldPayload } from "./transform-kobold-payload";

const OPENAI_CHAT_COMPLETION_ENDPOINT = "/v1/chat/completions";

/** Returns true if we're making a chat completion request. */
export function isCompletionRequest(req: Request) {
  return (
    req.method === "POST" &&
    req.path.startsWith(OPENAI_CHAT_COMPLETION_ENDPOINT)
  );
}

export type ExpressHttpProxyReqCallback = ProxyReqCallback<
  ClientRequest,
  Request
>;
