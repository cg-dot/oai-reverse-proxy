import {
  API_REQUEST_VALIDATORS,
  API_REQUEST_TRANSFORMERS,
} from "../../../../shared/api-schemas";
import { BadRequestError } from "../../../../shared/errors";
import { fixMistralPrompt } from "../../../../shared/api-schemas/mistral-ai";
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

  // TODO: this should be an APIFormatTransformer
  if (req.inboundApi === "mistral-ai") {
    const messages = req.body.messages;
    req.body.messages = fixMistralPrompt(messages);
    req.log.info(
      { old: messages.length, new: req.body.messages.length },
      "Fixed Mistral prompt"
    );
  }

  if (sameService) {
    const result = API_REQUEST_VALIDATORS[req.inboundApi].safeParse(req.body);
    if (!result.success) {
      req.log.warn(
        { issues: result.error.issues, body: req.body },
        "Request validation failed"
      );
      throw result.error;
    }
    req.body = result.data;
    return;
  }

  const transformation = `${req.inboundApi}->${req.outboundApi}` as const;
  const transFn = API_REQUEST_TRANSFORMERS[transformation];

  if (transFn) {
    req.log.info({ transformation }, "Transforming request");
    req.body = await transFn(req);
    return;
  }

  throw new BadRequestError(
    `${transformation} proxying is not supported. Make sure your client is configured to send requests in the correct format and to the correct endpoint.`
  );
};
