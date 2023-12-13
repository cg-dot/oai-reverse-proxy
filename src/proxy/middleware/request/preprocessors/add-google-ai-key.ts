import { keyPool } from "../../../../shared/key-management";
import { RequestPreprocessor } from "../index";

export const addGoogleAIKey: RequestPreprocessor = (req) => {
  const apisValid = req.inboundApi === "openai" && req.outboundApi === "google-ai";
  const serviceValid = req.service === "google-ai";
  if (!apisValid || !serviceValid) {
    throw new Error("addGoogleAIKey called on invalid request");
  }

  if (!req.body?.model) {
    throw new Error("You must specify a model with your request.");
  }

  const model = req.body.model;
  req.key = keyPool.get(model);

  req.log.info(
    { key: req.key.hash, model },
    "Assigned Google AI API key to request"
  );

  // https://generativelanguage.googleapis.com/v1beta/models/$MODEL_ID:generateContent?key=$API_KEY
  // https://generativelanguage.googleapis.com/v1beta/models/$MODEL_ID:streamGenerateContent?key=${API_KEY}

  req.isStreaming = req.isStreaming || req.body.stream;
  delete req.body.stream;

  req.signedRequest = {
    method: "POST",
    protocol: "https:",
    hostname: "generativelanguage.googleapis.com",
    path: `/v1beta/models/${model}:${req.isStreaming ? "streamGenerateContent" : "generateContent"}?key=${req.key.key}`,
    headers: {
      ["host"]: `generativelanguage.googleapis.com`,
      ["content-type"]: "application/json",
    },
    body: JSON.stringify(req.body),
  };
};
