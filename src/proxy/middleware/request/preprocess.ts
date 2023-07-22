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
    transformOutboundPayload,
    checkContextSize,
    ...(additionalPreprocessors ?? []),
  ];

  return async function executePreprocessors(req, res, next) {
    try {
      for (const preprocessor of preprocessors) {
        await preprocessor(req);
      }
      next();
    } catch (error) {
      req.log.error(error, "Error while executing request preprocessor");
      handleInternalError(error as Error, req, res);
    }
  };
};
