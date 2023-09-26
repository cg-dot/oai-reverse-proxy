import { RequestHandler } from "express";
import { handleInternalError } from "../common";
import {
  RequestPreprocessor,
  checkContextSize,
  setApiFormat,
  transformOutboundPayload,
} from ".";

/**
 * Returns a middleware function that processes the request body into the given
 * API format, and then sequentially runs the given additional preprocessors.
 */
export const createPreprocessorMiddleware = (
  apiFormat: Parameters<typeof setApiFormat>[0],
  additionalPreprocessors?: RequestPreprocessor[]
): RequestHandler => {
  const preprocessors: RequestPreprocessor[] = [
    setApiFormat(apiFormat),
    ...(additionalPreprocessors ?? []),
    transformOutboundPayload,
    checkContextSize,
  ];
  return async (...args) => executePreprocessors(preprocessors, args);
};

/**
 * Returns a middleware function that specifically prepares requests for
 * OpenAI's embeddings API. Tokens are not counted because embeddings requests
 * are basically free.
 */
export const createEmbeddingsPreprocessorMiddleware = (
  additionalPreprocessors?: RequestPreprocessor[]
): RequestHandler => {
  const preprocessors: RequestPreprocessor[] = [
    setApiFormat({ inApi: "openai", outApi: "openai" }),
    (req) => void (req.promptTokens = req.outputTokens = 0),
    ...(additionalPreprocessors ?? []),
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
    handleInternalError(error as Error, req, res);
  }
}
