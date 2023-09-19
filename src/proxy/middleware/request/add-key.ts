import { Key, OpenAIKey, keyPool } from "../../../shared/key-management";
import { isCompletionRequest } from "../common";
import { ProxyRequestMiddleware } from ".";
import { assertNever } from "../../../shared/utils";

/** Add a key that can service this request to the request object. */
export const addKey: ProxyRequestMiddleware = (proxyReq, req) => {
  let assignedKey: Key;

  if (!isCompletionRequest(req)) {
    // Horrible, horrible hack to stop the proxy from complaining about clients
    // not sending a model when they are requesting the list of models (which
    // requires a key, but obviously not a model).
    // TODO: shouldn't even proxy /models to the upstream API, just fake it
    // using the models our key pool has available.
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
    case "openai-text":
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
    default:
      assertNever(assignedKey.service);
  }
};
