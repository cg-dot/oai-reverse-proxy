import { openAIToAnthropic } from "../../../../shared/api-schemas/anthropic";
import { openAIToOpenAIText } from "../../../../shared/api-schemas/openai-text";
import { openAIToOpenAIImage } from "../../../../shared/api-schemas/openai-image";
import { openAIToGoogleAI } from "../../../../shared/api-schemas/google-ai";
import { fixMistralPrompt } from "../../../../shared/api-schemas/mistral-ai";
import { API_SCHEMA_VALIDATORS } from "../../../../shared/api-schemas";
import {
  isImageGenerationRequest,
  isTextGenerationRequest,
} from "../../common";
import { RequestPreprocessor } from "../index";

/** Transforms an incoming request body to one that matches the target API. */
export const transformOutboundPayload: RequestPreprocessor = async (req) => {
  const sameService = req.inboundApi === req.outboundApi;
  const alreadyTransformed = req.retryCount > 0;
  const notTransformable =
    !isTextGenerationRequest(req) && !isImageGenerationRequest(req);

  if (alreadyTransformed || notTransformable) return;

  if (req.inboundApi === "mistral-ai") {
    const messages = req.body.messages;
    req.body.messages = fixMistralPrompt(messages);
    req.log.info(
      { old: messages.length, new: req.body.messages.length },
      "Fixed Mistral prompt"
    );
  }

  if (sameService) {
    const result = API_SCHEMA_VALIDATORS[req.inboundApi].safeParse(req.body);
    if (!result.success) {
      req.log.error(
        { issues: result.error.issues, body: req.body },
        "Request validation failed"
      );
      throw result.error;
    }
    req.body = result.data;
    return;
  }

  if (req.inboundApi === "openai" && req.outboundApi === "anthropic") {
    req.body = openAIToAnthropic(req);
    return;
  }

  if (req.inboundApi === "openai" && req.outboundApi === "google-ai") {
    req.body = openAIToGoogleAI(req);
    return;
  }

  if (req.inboundApi === "openai" && req.outboundApi === "openai-text") {
    req.body = openAIToOpenAIText(req);
    return;
  }

  if (req.inboundApi === "openai" && req.outboundApi === "openai-image") {
    req.body = openAIToOpenAIImage(req);
    return;
  }

  throw new Error(
    `'${req.inboundApi}' -> '${req.outboundApi}' request proxying is not supported. Make sure your client is configured to use the correct API.`
  );
};
