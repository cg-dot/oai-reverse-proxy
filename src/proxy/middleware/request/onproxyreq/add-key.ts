import { Key, OpenAIKey, keyPool } from "../../../../shared/key-management";
import { isEmbeddingsRequest } from "../../common";
import { HPMRequestCallback } from "../index";
import { assertNever } from "../../../../shared/utils";

export const addKey: HPMRequestCallback = (proxyReq, req) => {
  let assignedKey: Key;
  const { service, inboundApi, outboundApi, body } = req;

  if (!inboundApi || !outboundApi) {
    const err = new Error(
      "Request API format missing. Did you forget to add the request preprocessor to your router?"
    );
    req.log.error({ inboundApi, outboundApi, path: req.path }, err.message);
    throw err;
  }

  if (!body?.model) {
    throw new Error("You must specify a model with your request.");
  }

  if (inboundApi === outboundApi) {
    assignedKey = keyPool.get(body.model, service);
  } else {
    switch (outboundApi) {
      // If we are translating between API formats we may need to select a model
      // for the user, because the provided model is for the inbound API.
      // TODO: This whole else condition is probably no longer needed since API
      // translation now reassigns the model earlier in the request pipeline.
      case "anthropic-chat":
      case "anthropic-text":
        assignedKey = keyPool.get("claude-v1", service);
        break;
      case "openai-text":
        assignedKey = keyPool.get("gpt-3.5-turbo-instruct", service);
        break;
      case "openai-image":
        assignedKey = keyPool.get("dall-e-3", service);
        break;
      case "openai":
      case "google-ai":
      case "mistral-ai":
        throw new Error(
          `add-key should not be called for outbound API ${outboundApi}`
        );
      default:
        assertNever(outboundApi);
    }
  }

  req.key = assignedKey;
  req.log.info(
    { key: assignedKey.hash, model: body.model, inboundApi, outboundApi },
    "Assigned key to request"
  );

  // TODO: KeyProvider should assemble all necessary headers
  switch (assignedKey.service) {
    case "anthropic":
      proxyReq.setHeader("X-API-Key", assignedKey.key);
      break;
    case "openai":
      const key: OpenAIKey = assignedKey as OpenAIKey;
      if (key.organizationId) {
        proxyReq.setHeader("OpenAI-Organization", key.organizationId);
      }
      proxyReq.setHeader("Authorization", `Bearer ${assignedKey.key}`);
      break;
    case "mistral-ai":
      proxyReq.setHeader("Authorization", `Bearer ${assignedKey.key}`);
      break;
    case "azure":
      const azureKey = assignedKey.key;
      proxyReq.setHeader("api-key", azureKey);
      break;
    case "aws":
    case "google-ai":
      throw new Error("add-key should not be used for this service.");
    default:
      assertNever(assignedKey.service);
  }
};

/**
 * Special case for embeddings requests which don't go through the normal
 * request pipeline.
 */
export const addKeyForEmbeddingsRequest: HPMRequestCallback = (
  proxyReq,
  req
) => {
  if (!isEmbeddingsRequest(req)) {
    throw new Error(
      "addKeyForEmbeddingsRequest called on non-embeddings request"
    );
  }

  if (req.inboundApi !== "openai") {
    throw new Error("Embeddings requests must be from OpenAI");
  }

  req.body = { input: req.body.input, model: "text-embedding-ada-002" };

  const key = keyPool.get("text-embedding-ada-002", "openai") as OpenAIKey;

  req.key = key;
  req.log.info(
    { key: key.hash, toApi: req.outboundApi },
    "Assigned Turbo key to embeddings request"
  );

  proxyReq.setHeader("Authorization", `Bearer ${key.key}`);
  if (key.organizationId) {
    proxyReq.setHeader("OpenAI-Organization", key.organizationId);
  }
};
