import { Key, OpenAIKey, keyPool } from "../../../shared/key-management";
import { isCompletionRequest, isEmbeddingsRequest } from "../common";
import { ProxyRequestMiddleware } from ".";
import { assertNever } from "../../../shared/utils";

/** Add a key that can service this request to the request object. */
export const addKey: ProxyRequestMiddleware = (proxyReq, req) => {
  let assignedKey: Key;

  if (!isCompletionRequest(req)) {
    // Horrible, horrible hack to stop the proxy from complaining about clients
    // not sending a model when they are requesting the list of models (which
    // requires a key, but obviously not a model).

    // I don't think this is needed anymore since models requests are no longer
    // proxied to the upstream API. Everything going through this is either a
    // completion request or a special case like OpenAI embeddings.
    req.log.warn({ path: req.path }, "addKey called on non-completion request");
    req.body.model = "gpt-3.5-turbo";
  }

  if (!req.inboundApi || !req.outboundApi) {
    const err = new Error(
      "Request API format missing. Did you forget to add the request preprocessor to your router?"
    );
    req.log.error(
      { in: req.inboundApi, out: req.outboundApi, path: req.path },
      err.message
    );
    throw err;
  }

  if (!req.body?.model) {
    throw new Error("You must specify a model with your request.");
  }

  // TODO: use separate middleware to deal with stream flags
  req.isStreaming = req.body.stream === true || req.body.stream === "true";
  req.body.stream = req.isStreaming;

  if (req.inboundApi === req.outboundApi) {
    assignedKey = keyPool.get(req.body.model);
  } else {
    switch (req.outboundApi) {
      // If we are translating between API formats we may need to select a model
      // for the user, because the provided model is for the inbound API.
      case "anthropic":
        assignedKey = keyPool.get("claude-v1");
        break;
      case "google-palm":
        assignedKey = keyPool.get("text-bison-001");
        delete req.body.stream;
        break;
      case "openai-text":
        assignedKey = keyPool.get("gpt-3.5-turbo-instruct");
        break;
      case "openai":
        throw new Error(
          "OpenAI Chat as an API translation target is not supported"
        );
      default:
        assertNever(req.outboundApi);
    }
  }

  req.key = assignedKey;
  req.log.info(
    {
      key: assignedKey.hash,
      model: req.body?.model,
      fromApi: req.inboundApi,
      toApi: req.outboundApi,
    },
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
    case "google-palm":
      const originalPath = proxyReq.path;
      proxyReq.path = originalPath.replace(
        /(\?.*)?$/,
        `?key=${assignedKey.key}`
      );
      break;
    case "aws":
      throw new Error(
        "add-key should not be used for AWS security credentials. Use sign-aws-request instead."
      );
    default:
      assertNever(assignedKey.service);
  }
};

/**
 * Special case for embeddings requests which don't go through the normal
 * request pipeline.
 */
export const addKeyForEmbeddingsRequest: ProxyRequestMiddleware = (
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

  req.body = { input: req.body.input, model: "text-embedding-ada-002" }

  const key = keyPool.get("text-embedding-ada-002") as OpenAIKey;

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
