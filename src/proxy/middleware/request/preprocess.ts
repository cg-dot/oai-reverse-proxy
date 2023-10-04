import { RequestHandler } from "express";
import { initializeSseStream } from "../../../shared/streaming";
import { classifyErrorAndSend } from "../common";
import {
  RequestPreprocessor,
  validateContextSize,
  countPromptTokens,
  setApiFormat,
  transformOutboundPayload,
} from ".";

type RequestPreprocessorOptions = {
  /**
   * Functions to run before the request body is transformed between API
   * formats. Use this to change the behavior of the transformation, such as for
   * endpoints which can accept multiple API formats.
   */
  beforeTransform?: RequestPreprocessor[];
  /**
   * Functions to run after the request body is transformed and token counts are
   * assigned. Use this to perform validation or other actions that depend on
   * the request body being in the final API format.
   */
  afterTransform?: RequestPreprocessor[];
};

/**
 * Returns a middleware function that processes the request body into the given
 * API format, and then sequentially runs the given additional preprocessors.
 */
export const createPreprocessorMiddleware = (
  apiFormat: Parameters<typeof setApiFormat>[0],
  { beforeTransform, afterTransform }: RequestPreprocessorOptions = {}
): RequestHandler => {
  const preprocessors: RequestPreprocessor[] = [
    setApiFormat(apiFormat),
    ...(beforeTransform ?? []),
    transformOutboundPayload,
    countPromptTokens,
    ...(afterTransform ?? []),
    validateContextSize,
  ];
  return async (...args) => executePreprocessors(preprocessors, args);
};

/**
 * Returns a middleware function that specifically prepares requests for
 * OpenAI's embeddings API. Tokens are not counted because embeddings requests
 * are basically free.
 */
export const createEmbeddingsPreprocessorMiddleware = (): RequestHandler => {
  const preprocessors: RequestPreprocessor[] = [
    setApiFormat({ inApi: "openai", outApi: "openai", service: "openai" }),
    (req) => void (req.promptTokens = req.outputTokens = 0),
  ];
  return async (...args) => executePreprocessors(preprocessors, args);
};

async function executePreprocessors(
  preprocessors: RequestPreprocessor[],
  [req, res, next]: Parameters<RequestHandler>
) {
  try {
    for (const preprocessor of preprocessors) {
      await preprocessor(req);
    }
    next();
  } catch (error) {
    req.log.error(error, "Error while executing request preprocessor");

    // If the requested has opted into streaming, the client probably won't
    // handle a non-eventstream response, but we haven't initialized the SSE
    // stream yet as that is typically done later by the request queue. We'll
    // do that here and then call classifyErrorAndSend to use the streaming
    // error handler.
    initializeSseStream(res)
    classifyErrorAndSend(error as Error, req, res);
  }
}
