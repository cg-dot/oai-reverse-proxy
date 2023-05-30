import type { Request } from "express";
import type { ClientRequest } from "http";
import type { ProxyReqCallback } from "http-proxy";

export { addKey } from "./add-key";
export { finalizeBody } from "./finalize-body";
export { languageFilter } from "./language-filter";
export { limitCompletions } from "./limit-completions";
export { limitOutputTokens } from "./limit-output-tokens";
export { setApiFormat } from "./set-api-format";
export { transformKoboldPayload } from "./transform-kobold-payload";
export { transformOutboundPayload } from "./transform-outbound-payload";

const OPENAI_CHAT_COMPLETION_ENDPOINT = "/v1/chat/completions";
const ANTHROPIC_COMPLETION_ENDPOINT = "/v1/complete";

/** Returns true if we're making a request to a completion endpoint. */
export function isCompletionRequest(req: Request) {
  return (
    req.method === "POST" &&
    [OPENAI_CHAT_COMPLETION_ENDPOINT, ANTHROPIC_COMPLETION_ENDPOINT].some(
      (endpoint) => req.path.startsWith(endpoint)
    )
  );
}

export type ExpressHttpProxyReqCallback = ProxyReqCallback<
  ClientRequest,
  Request
>;
