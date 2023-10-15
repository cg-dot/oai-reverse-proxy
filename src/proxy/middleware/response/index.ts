/* This file is fucking horrendous, sorry */
import { Request, Response } from "express";
import * as http from "http";
import util from "util";
import zlib from "zlib";
import { logger } from "../../../logger";
import { enqueue, trackWaitTime } from "../../queue";
import { HttpError } from "../../../shared/errors";
import { keyPool } from "../../../shared/key-management";
import { getOpenAIModelFamily } from "../../../shared/models";
import { countTokens } from "../../../shared/tokenization";
import {
  incrementPromptCount,
  incrementTokenCount,
} from "../../../shared/users/user-store";
import { assertNever } from "../../../shared/utils";
import {
  getCompletionFromBody,
  isCompletionRequest,
  writeErrorResponse,
} from "../common";
import { handleStreamedResponse } from "./handle-streamed-response";
import { logPrompt } from "./log-prompt";

const DECODER_MAP = {
  gzip: util.promisify(zlib.gunzip),
  deflate: util.promisify(zlib.inflate),
  br: util.promisify(zlib.brotliDecompress),
};

const isSupportedContentEncoding = (
  contentEncoding: string
): contentEncoding is keyof typeof DECODER_MAP => {
  return contentEncoding in DECODER_MAP;
};

export class RetryableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RetryableError";
  }
}

/**
 * Either decodes or streams the entire response body and then passes it as the
 * last argument to the rest of the middleware stack.
 */
export type RawResponseBodyHandler = (
  proxyRes: http.IncomingMessage,
  req: Request,
  res: Response
) => Promise<string | Record<string, any>>;
export type ProxyResHandlerWithBody = (
  proxyRes: http.IncomingMessage,
  req: Request,
  res: Response,
  /**
   * This will be an object if the response content-type is application/json,
   * or if the response is a streaming response. Otherwise it will be a string.
   */
  body: string | Record<string, any>
) => Promise<void>;
export type ProxyResMiddleware = ProxyResHandlerWithBody[];

/**
 * Returns a on.proxyRes handler that executes the given middleware stack after
 * the common proxy response handlers have processed the response and decoded
 * the body.  Custom middleware won't execute if the response is determined to
 * be an error from the upstream service as the response will be taken over by
 * the common error handler.
 *
 * For streaming responses, the handleStream middleware will block remaining
 * middleware from executing as it consumes the stream and forwards events to
 * the client. Once the stream is closed, the finalized body will be attached
 * to res.body and the remaining middleware will execute.
 */
export const createOnProxyResHandler = (apiMiddleware: ProxyResMiddleware) => {
  return async (
    proxyRes: http.IncomingMessage,
    req: Request,
    res: Response
  ) => {
    const initialHandler = req.isStreaming
      ? handleStreamedResponse
      : decodeResponseBody;

    let lastMiddleware = initialHandler.name;

    try {
      const body = await initialHandler(proxyRes, req, res);

      const middlewareStack: ProxyResMiddleware = [];

      if (req.isStreaming) {
        // `handleStreamedResponse` writes to the response and ends it, so
        // we can only execute middleware that doesn't write to the response.
        middlewareStack.push(
          trackRateLimit,
          countResponseTokens,
          incrementUsage,
          logPrompt
        );
      } else {
        middlewareStack.push(
          trackRateLimit,
          handleUpstreamErrors,
          countResponseTokens,
          incrementUsage,
          copyHttpHeaders,
          logPrompt,
          ...apiMiddleware
        );
      }

      for (const middleware of middlewareStack) {
        lastMiddleware = middleware.name;
        await middleware(proxyRes, req, res, body);
      }

      trackWaitTime(req);
    } catch (error) {
      // Hack: if the error is a retryable rate-limit error, the request has
      // been re-enqueued and we can just return without doing anything else.
      if (error instanceof RetryableError) {
        return;
      }

      // Already logged and responded to the client by handleUpstreamErrors
      if (error instanceof HttpError) {
        if (!res.writableEnded) res.end();
        return;
      }

      const { stack, message } = error;
      const info = { stack, lastMiddleware, key: req.key?.hash };
      const description = `Error while executing proxy response middleware: ${lastMiddleware} (${message})`;

      if (res.headersSent) {
        req.log.error(info, description);
        if (!res.writableEnded) res.end();
        return;
      } else {
        req.log.error(info, description);
        res
          .status(500)
          .json({ error: "Internal server error", proxy_note: description });
      }
    }
  };
};

function reenqueueRequest(req: Request) {
  req.log.info(
    { key: req.key?.hash, retryCount: req.retryCount },
    `Re-enqueueing request due to retryable error`
  );
  req.retryCount++;
  enqueue(req);
}

/**
 * Handles the response from the upstream service and decodes the body if
 * necessary.  If the response is JSON, it will be parsed and returned as an
 * object.  Otherwise, it will be returned as a string.
 * @throws {Error} Unsupported content-encoding or invalid application/json body
 */
export const decodeResponseBody: RawResponseBodyHandler = async (
  proxyRes,
  req,
  res
) => {
  if (req.isStreaming) {
    const err = new Error("decodeResponseBody called for a streaming request.");
    req.log.error({ stack: err.stack, api: req.inboundApi }, err.message);
    throw err;
  }

  return new Promise<string>((resolve, reject) => {
    let chunks: Buffer[] = [];
    proxyRes.on("data", (chunk) => chunks.push(chunk));
    proxyRes.on("end", async () => {
      let body = Buffer.concat(chunks);

      const contentEncoding = proxyRes.headers["content-encoding"];
      if (contentEncoding) {
        if (isSupportedContentEncoding(contentEncoding)) {
          const decoder = DECODER_MAP[contentEncoding];
          body = await decoder(body);
        } else {
          const errorMessage = `Proxy received response with unsupported content-encoding: ${contentEncoding}`;
          logger.warn({ contentEncoding, key: req.key?.hash }, errorMessage);
          writeErrorResponse(req, res, 500, {
            error: errorMessage,
            contentEncoding,
          });
          return reject(errorMessage);
        }
      }

      try {
        if (proxyRes.headers["content-type"]?.includes("application/json")) {
          const json = JSON.parse(body.toString());
          return resolve(json);
        }
        return resolve(body.toString());
      } catch (error: any) {
        const errorMessage = `Proxy received response with invalid JSON: ${error.message}`;
        logger.warn({ error: error.stack, key: req.key?.hash }, errorMessage);
        writeErrorResponse(req, res, 500, { error: errorMessage });
        return reject(errorMessage);
      }
    });
  });
};

type ProxiedErrorPayload = {
  error?: Record<string, any>;
  message?: string;
  proxy_note?: string;
};

/**
 * Handles non-2xx responses from the upstream service.  If the proxied response
 * is an error, this will respond to the client with an error payload and throw
 * an error to stop the middleware stack.
 * On 429 errors, if request queueing is enabled, the request will be silently
 * re-enqueued.  Otherwise, the request will be rejected with an error payload.
 * @throws {HttpError} On HTTP error status code from upstream service
 */
const handleUpstreamErrors: ProxyResHandlerWithBody = async (
  proxyRes,
  req,
  res,
  body
) => {
  const statusCode = proxyRes.statusCode || 500;

  if (statusCode < 400) {
    return;
  }

  let errorPayload: ProxiedErrorPayload;
  const tryAgainMessage = keyPool.available(req.body?.model)
    ? `There may be more keys available for this model; try again in a few seconds.`
    : "There are no more keys available for this model.";

  try {
    assertJsonResponse(body);
    errorPayload = body;
  } catch (parseError) {
    // Likely Bad Gateway or Gateway Timeout from upstream's reverse proxy
    const hash = req.key?.hash;
    const statusMessage = proxyRes.statusMessage || "Unknown error";
    logger.warn({ statusCode, statusMessage, key: hash }, parseError.message);

    const errorObject = {
      statusCode,
      statusMessage: proxyRes.statusMessage,
      error: parseError.message,
      proxy_note: `This is likely a temporary error with the upstream service.`,
    };
    writeErrorResponse(req, res, statusCode, errorObject);
    throw new HttpError(statusCode, parseError.message);
  }

  const errorType =
    errorPayload.error?.code ||
    errorPayload.error?.type ||
    getAwsErrorType(proxyRes.headers["x-amzn-errortype"]);

  logger.warn(
    { statusCode, type: errorType, errorPayload, key: req.key?.hash },
    `Received error response from upstream. (${proxyRes.statusMessage})`
  );

  const service = req.key!.service;
  if (service === "aws") {
    // Try to standardize the error format for AWS
    errorPayload.error = { message: errorPayload.message, type: errorType };
    delete errorPayload.message;
  }

  if (statusCode === 400) {
    // Bad request. For OpenAI, this is usually due to prompt length.
    // For Anthropic, this is usually due to missing preamble.
    switch (service) {
      case "openai":
      case "google-palm":
        errorPayload.proxy_note = `Upstream service rejected the request as invalid. Your prompt may be too long for ${req.body?.model}.`;
        break;
      case "anthropic":
      case "aws":
        maybeHandleMissingPreambleError(req, errorPayload);
        break;
      default:
        assertNever(service);
    }
  } else if (statusCode === 401) {
    // Key is invalid or was revoked
    keyPool.disable(req.key!, "revoked");
    errorPayload.proxy_note = `API key is invalid or revoked. ${tryAgainMessage}`;
  } else if (statusCode === 403) {
    // Amazon is the only service that returns 403.
    switch (errorType) {
      case "UnrecognizedClientException":
        // Key is invalid.
        keyPool.disable(req.key!, "revoked");
        errorPayload.proxy_note = `API key is invalid or revoked. ${tryAgainMessage}`;
        break;
      case "AccessDeniedException":
        req.log.error(
          { key: req.key?.hash, model: req.body?.model },
          "Disabling key due to AccessDeniedException when invoking model. If credentials are valid, check IAM permissions."
        );
        keyPool.disable(req.key!, "revoked");
        errorPayload.proxy_note = `API key doesn't have access to the requested resource.`;
        break;
      default:
        errorPayload.proxy_note = `Received 403 error. Key may be invalid.`;
    }
  } else if (statusCode === 429) {
    switch (service) {
      case "openai":
        handleOpenAIRateLimitError(req, tryAgainMessage, errorPayload);
        break;
      case "anthropic":
        handleAnthropicRateLimitError(req, errorPayload);
        break;
      case "aws":
        handleAwsRateLimitError(req, errorPayload);
        break;
      case "google-palm":
        throw new Error("Rate limit handling not implemented for PaLM");
      default:
        assertNever(service);
    }
  } else if (statusCode === 404) {
    // Most likely model not found
    switch (service) {
      case "openai":
        if (errorPayload.error?.code === "model_not_found") {
          const requestedModel = req.body.model;
          const modelFamily = getOpenAIModelFamily(requestedModel);
          errorPayload.proxy_note = `The key assigned to your prompt does not support the requested model (${requestedModel}, family: ${modelFamily}).`;
          req.log.error(
            { key: req.key?.hash, model: requestedModel, modelFamily },
            "Prompt was routed to a key that does not support the requested model."
          );
        }
        break;
      case "anthropic":
        errorPayload.proxy_note = `The requested Claude model might not exist, or the key might not be provisioned for it.`;
        break;
      case "google-palm":
        errorPayload.proxy_note = `The requested Google PaLM model might not exist, or the key might not be provisioned for it.`;
        break;
      case "aws":
        errorPayload.proxy_note = `The requested AWS resource might not exist, or the key might not have access to it.`;
        break;
      default:
        assertNever(service);
    }
  } else {
    errorPayload.proxy_note = `Unrecognized error from upstream service.`;
  }

  // Some OAI errors contain the organization ID, which we don't want to reveal.
  if (errorPayload.error?.message) {
    errorPayload.error.message = errorPayload.error.message.replace(
      /org-.{24}/gm,
      "org-xxxxxxxxxxxxxxxxxxx"
    );
  }

  writeErrorResponse(req, res, statusCode, errorPayload);
  throw new HttpError(statusCode, errorPayload.error?.message);
};

/**
 * This is a workaround for a very strange issue where certain API keys seem to
 * enforce more strict input validation than others -- specifically, they will
 * require a `\n\nHuman:` prefix on the prompt, perhaps to prevent the key from
 * being used as a generic text completion service and to enforce the use of
 * the chat RLHF.  This is not documented anywhere, and it's not clear why some
 * keys enforce this and others don't.
 * This middleware checks for that specific error and marks the key as being
 * one that requires the prefix, and then re-enqueues the request.
 * The exact error is:
 * ```
 * {
 *   "error": {
 *     "type": "invalid_request_error",
 *     "message": "prompt must start with \"\n\nHuman:\" turn"
 *   }
 * }
 * ```
 */
function maybeHandleMissingPreambleError(
  req: Request,
  errorPayload: ProxiedErrorPayload
) {
  if (
    errorPayload.error?.type === "invalid_request_error" &&
    errorPayload.error?.message === 'prompt must start with "\n\nHuman:" turn'
  ) {
    req.log.warn(
      { key: req.key?.hash },
      "Request failed due to missing preamble. Key will be marked as such for subsequent requests."
    );
    keyPool.update(req.key!, { requiresPreamble: true });
    reenqueueRequest(req);
    throw new RetryableError("Claude request re-enqueued to add preamble.");
  } else {
    errorPayload.proxy_note = `Proxy received unrecognized error from Anthropic. Check the specific error for more information.`;
  }
}

function handleAnthropicRateLimitError(
  req: Request,
  errorPayload: ProxiedErrorPayload
) {
  if (errorPayload.error?.type === "rate_limit_error") {
    keyPool.markRateLimited(req.key!);
    reenqueueRequest(req);
    throw new RetryableError("Claude rate-limited request re-enqueued.");
  } else {
    errorPayload.proxy_note = `Unrecognized rate limit error from Anthropic. Key may be over quota.`;
  }
}

function handleAwsRateLimitError(
  req: Request,
  errorPayload: ProxiedErrorPayload
) {
  const errorType = errorPayload.error?.type;
  switch (errorType) {
    case "ThrottlingException":
      keyPool.markRateLimited(req.key!);
      reenqueueRequest(req);
      throw new RetryableError("AWS rate-limited request re-enqueued.");
    case "ModelNotReadyException":
      errorPayload.proxy_note = `The requested model is overloaded. Try again in a few seconds.`;
      break;
    default:
      errorPayload.proxy_note = `Unrecognized rate limit error from AWS. (${errorType})`;
  }
}

function handleOpenAIRateLimitError(
  req: Request,
  tryAgainMessage: string,
  errorPayload: ProxiedErrorPayload
): Record<string, any> {
  const type = errorPayload.error?.type;
  switch (type) {
    case "insufficient_quota":
      // Billing quota exceeded (key is dead, disable it)
      keyPool.disable(req.key!, "quota");
      errorPayload.proxy_note = `Assigned key's quota has been exceeded. ${tryAgainMessage}`;
      break;
    case "access_terminated":
      // Account banned (key is dead, disable it)
      keyPool.disable(req.key!, "revoked");
      errorPayload.proxy_note = `Assigned key has been banned by OpenAI for policy violations. ${tryAgainMessage}`;
      break;
    case "billing_not_active":
      // Key valid but account billing is delinquent
      keyPool.disable(req.key!, "quota");
      errorPayload.proxy_note = `Assigned key has been disabled due to delinquent billing. ${tryAgainMessage}`;
      break;
    case "requests":
    case "tokens":
      // Per-minute request or token rate limit is exceeded, which we can retry
      keyPool.markRateLimited(req.key!);
      reenqueueRequest(req);
      throw new RetryableError("Rate-limited request re-enqueued.");
    default:
      errorPayload.proxy_note = `This is likely a temporary error with OpenAI. Try again in a few seconds.`;
      break;
  }
  return errorPayload;
}

const incrementUsage: ProxyResHandlerWithBody = async (_proxyRes, req) => {
  if (isCompletionRequest(req)) {
    const model = req.body.model;
    const tokensUsed = req.promptTokens! + req.outputTokens!;
    keyPool.incrementUsage(req.key!, model, tokensUsed);
    if (req.user) {
      incrementPromptCount(req.user.token);
      incrementTokenCount(req.user.token, model, tokensUsed);
    }
  }
};

const countResponseTokens: ProxyResHandlerWithBody = async (
  _proxyRes,
  req,
  _res,
  body
) => {
  // This function is prone to breaking if the upstream API makes even minor
  // changes to the response format, especially for SSE responses. If you're
  // seeing errors in this function, check the reassembled response body from
  // handleStreamedResponse to see if the upstream API has changed.
  try {
    assertJsonResponse(body);
    const service = req.outboundApi;
    const completion = getCompletionFromBody(req, body);
    const tokens = await countTokens({ req, completion, service });

    req.log.debug(
      { service, tokens, prevOutputTokens: req.outputTokens },
      `Counted tokens for completion`
    );
    if (req.debug) {
      req.debug.completion_tokens = tokens;
    }

    req.outputTokens = tokens.token_count;
  } catch (error) {
    req.log.warn(
      error,
      "Error while counting completion tokens; assuming `max_output_tokens`"
    );
    // req.outputTokens will already be set to `max_output_tokens` from the
    // prompt counting middleware, so we don't need to do anything here.
  }
};

const trackRateLimit: ProxyResHandlerWithBody = async (proxyRes, req) => {
  keyPool.updateRateLimits(req.key!, proxyRes.headers);
};

const copyHttpHeaders: ProxyResHandlerWithBody = async (
  proxyRes,
  _req,
  res
) => {
  Object.keys(proxyRes.headers).forEach((key) => {
    // Omit content-encoding because we will always decode the response body
    if (key === "content-encoding") {
      return;
    }
    // We're usually using res.json() to send the response, which causes express
    // to set content-length. That's not valid for chunked responses and some
    // clients will reject it so we need to omit it.
    if (key === "transfer-encoding") {
      return;
    }
    res.setHeader(key, proxyRes.headers[key] as string);
  });
};

function getAwsErrorType(header: string | string[] | undefined) {
  const val = String(header).match(/^(\w+):?/)?.[1];
  return val || String(header);
}

function assertJsonResponse(body: any): asserts body is Record<string, any> {
  if (typeof body !== "object") {
    throw new Error("Expected response to be an object");
  }
}
