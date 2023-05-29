import { Key, keyPool } from "../../../key-management";
import type { ExpressHttpProxyReqCallback } from ".";

/** Add a key that can service this request to the request object. */
export const addKey: ExpressHttpProxyReqCallback = (proxyReq, req) => {
  let assignedKey: Key;

  if (!req.body?.model) {
    throw new Error("You must specify a model with your request.");
  }

  // This should happen somewhere else but addKey is guaranteed to run first.
  req.isStreaming = req.body.stream === true || req.body.stream === "true";
  req.body.stream = req.isStreaming;

  // Anthropic support has a special endpoint that accepts OpenAI-formatted
  // requests and translates them into Anthropic requests.  On this endpoint,
  // the requested model is an OpenAI one even though we're actually sending
  // an Anthropic request.
  // For such cases, ignore the requested model entirely.
  // Real Anthropic requests come in via /proxy/anthropic/v1/complete
  // The OpenAI-compatible endpoint is /proxy/anthropic/v1/chat/completions

  const openaiCompatible =
    req.originalUrl === "/proxy/anthropic/v1/chat/completions";
  if (openaiCompatible) {
    req.log.debug("Using an Anthropic key for an OpenAI-compatible request");
    req.api = "openai";
    // We don't assign the model here, that will happen when transforming the
    // request body.
    assignedKey = keyPool.get("claude-v1");
  } else {
    assignedKey = keyPool.get(req.body.model);
  }

  req.key = assignedKey;
  req.log.info(
    {
      key: assignedKey.hash,
      model: req.body?.model,
      fromApi: req.api,
      toApi: assignedKey.service,
    },
    "Assigned key to request"
  );

  if (assignedKey.service === "anthropic") {
    proxyReq.setHeader("X-API-Key", assignedKey.key);
  } else {
    proxyReq.setHeader("Authorization", `Bearer ${assignedKey.key}`);
  }
};
