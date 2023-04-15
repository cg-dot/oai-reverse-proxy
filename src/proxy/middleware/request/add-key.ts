import { Key, Model, keyPool, SUPPORTED_MODELS } from "../../../key-management";
import type { ExpressHttpProxyReqCallback } from ".";

/** Add an OpenAI key from the pool to the request. */
export const addKey: ExpressHttpProxyReqCallback = (proxyReq, req) => {
  let assignedKey: Key;

  // Not all clients request a particular model.
  // If they request a model, just use that.
  // If they don't request a model, use a GPT-4 key if there is an active one,
  // otherwise use a GPT-3.5 key.

  // TODO: Anthropic mode should prioritize Claude over Claude Instant.
  // Each provider needs to define some priority order for their models.

  if (bodyHasModel(req.body)) {
    assignedKey = keyPool.get(req.body.model);
  } else {
    try {
      assignedKey = keyPool.get("gpt-4");
    } catch {
      assignedKey = keyPool.get("gpt-3.5-turbo");
    }
  }
  req.key = assignedKey;
  req.log.info(
    {
      key: assignedKey.hash,
      model: req.body?.model,
      isGpt4: assignedKey.isGpt4,
    },
    "Assigned key to request"
  );

  // TODO: Requests to Anthropic models use `X-API-Key`.
  proxyReq.setHeader("Authorization", `Bearer ${assignedKey.key}`);
};

function bodyHasModel(body: any): body is { model: Model } {
  // Model names can have suffixes indicating the frozen release version but
  // OpenAI and Anthropic will use the latest version if you omit the suffix.
  const isSupportedModel = (model: string) =>
    SUPPORTED_MODELS.some((supported) => model.startsWith(supported));
  return typeof body?.model === "string" && isSupportedModel(body.model);
}
