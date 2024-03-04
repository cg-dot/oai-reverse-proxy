import { fixRequestBody } from "http-proxy-middleware";
import type { HPMRequestCallback } from "../index";

/** Finalize the rewritten request body. Must be the last rewriter. */
export const finalizeBody: HPMRequestCallback = (proxyReq, req) => {
  if (["POST", "PUT", "PATCH"].includes(req.method ?? "") && req.body) {
    // For image generation requests, remove stream flag.
    if (req.outboundApi === "openai-image") {
      delete req.body.stream;
    }
    // For anthropic text to chat requests, remove undefined prompt.
    if (req.outboundApi === "anthropic-chat") {
      delete req.body.prompt;
    }

    const updatedBody = JSON.stringify(req.body);
    proxyReq.setHeader("Content-Length", Buffer.byteLength(updatedBody));
    (req as any).rawBody = Buffer.from(updatedBody);

    // body-parser and http-proxy-middleware don't play nice together
    fixRequestBody(proxyReq, req);
  }
};
