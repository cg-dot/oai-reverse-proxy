/* This file is fucking horrendous, sorry */
import { Request, Response } from "express";
import * as http from "http";
import util from "util";
import zlib from "zlib";
import { logger } from "../../../logger";
import { keyPool } from "../../../shared/key-management";
import { getOpenAIModelFamily } from "../../../shared/models";
import { enqueue, trackWaitTime } from "../../queue";
import {
  incrementPromptCount,
  incrementTokenCount,
} from "../../../shared/users/user-store";
import {
  getCompletionForService,
  isCompletionRequest,
  writeErrorResponse,
} from "../common";
import { handleStreamedResponse } from "./handle-streamed-response";
import { logPrompt } from "./log-prompt";
import { countTokens } from "../../../shared/tokenization";
import { assertNever } from "../../../shared/utils";

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

class RetryableError extends Error {
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

    let lastMiddlewareName = initialHandler.name;

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
        lastMiddlewareName = middleware.name;
        await middleware(proxyRes, req, res, body);
      }

      trackWaitTime(req);
    } catch (error: any) {
      // Hack: if the error is a retryable rate-limit error, the request has
      // been re-enqueued and we can just return without doing anything else.
      if (error instanceof RetryableError) {
        return;
      }

      const errorData = {
        error: error.stack,
        thrownBy: lastMiddlewareName,
        key: req.key?.hash,
      };
      const message = `Error while executing proxy response middleware: ${lastMiddlewareName} (${error.message})`;
      if (res.headersSent) {
        req.log.error(errorData, message);
        // This should have already been handled by the error handler, but
        // just in case...
        if (!res.writableEnded) {
          res.end();
        }
        return;
      }
      logger.error(errorData, message);
      res
        .status(500)
        .json({ error: "Internal server error", proxy_note: message });
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

  const promise = new Promise<string>((resolve, reject) => {
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
        logger.warn({ error, key: req.key?.hash }, errorMessage);
        writeErrorResponse(req, res, 500, { error: errorMessage });
        return reject(errorMessage);
      }
    });
  });
  return promise;
};

// TODO: This is too specific to OpenAI's error responses.
/**
 * Handles non-2xx responses from the upstream service.  If the proxied response
 * is an error, this will respond to the client with an error payload and throw
 * an error to stop the middleware stack.
 * On 429 errors, if request queueing is enabled, the request will be silently
 * re-enqueued.  Otherwise, the request will be rejected with an error payload.
 * @throws {Error} On HTTP error status code from upstream service
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

  let errorPayload: Record<string, any>;
  // Subtract 1 from available keys because if this message is being shown,
  // it's because the key is about to be disabled.
  const availableKeys = keyPool.available(req.outboundApi) - 1;
  const tryAgainMessage = Boolean(availableKeys)
    ? `There are ${availableKeys} more keys available; try your request again.`
    : "There are no more keys available.";

  try {
    if (typeof body === "object") {
      errorPayload = body;
    } else {
      throw new Error("Received unparsable error response from upstream.");
    }
  } catch (parseError: any) {
    const statusMessage = proxyRes.statusMessage || "Unknown error";
    // Likely Bad Gateway or Gateway Timeout from reverse proxy/load balancer
    logger.warn(
      { statusCode, statusMessage, key: req.key?.hash },
      parseError.message
    );

    const errorObject = {
      statusCode,
      statusMessage: proxyRes.statusMessage,
      error: parseError.message,
      proxy_note: `This is likely a temporary error with the upstream service.`,
    };
    writeErrorResponse(req, res, statusCode, errorObject);
    throw new Error(parseError.message);
  }

  logger.warn(
    {
      statusCode,
      type: errorPayload.error?.code,
      errorPayload,
      key: req.key?.hash,
    },
    `Received error response from upstream. (${proxyRes.statusMessage})`
  );

  if (statusCode === 400) {
    // Bad request (likely prompt is too long)
    switch (req.outboundApi) {
      case "openai":
      case "openai-text":
      case "google-palm":
        errorPayload.proxy_note = `Upstream service rejected the request as invalid. Your prompt may be too long for ${req.body?.model}.`;
        break;
      case "anthropic":
        maybeHandleMissingPreambleError(req, errorPayload);
        break;
      default:
        assertNever(req.outboundApi);
    }
  } else if (statusCode === 401) {
    // Key is invalid or was revoked
    keyPool.disable(req.key!, "revoked");
    errorPayload.proxy_note = `API key is invalid or revoked. ${tryAgainMessage}`;
  } else if (statusCode === 429) {
    switch (req.outboundApi) {
      case "openai":
      case "openai-text":
        handleOpenAIRateLimitError(req, tryAgainMessage, errorPayload);
        break;
      case "anthropic":
        handleAnthropicRateLimitError(req, errorPayload);
        break;
      case "google-palm":
        throw new Error("Rate limit handling not implemented for PaLM");
      default:
        assertNever(req.outboundApi);
    }
  } else if (statusCode === 404) {
    // Most likely model not found
    switch (req.outboundApi) {
      case "openai":
      case "openai-text":
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
      default:
        assertNever(req.outboundApi);
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
  throw new Error(errorPayload.error?.message);
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
  errorPayload: Record<string, any>
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
  errorPayload: Record<string, any>
) {
  if (errorPayload.error?.type === "rate_limit_error") {
    keyPool.markRateLimited(req.key!);
    reenqueueRequest(req);
    throw new RetryableError("Claude rate-limited request re-enqueued.");
  } else {
    errorPayload.proxy_note = `Unrecognized rate limit error from Anthropic. Key may be over quota.`;
  }
}

function handleOpenAIRateLimitError(
  req: Request,
  tryAgainMessage: string,
  errorPayload: Record<string, any>
): Record<string, any> {
  const type = errorPayload.error?.type;
  if (type === "insufficient_quota") {
    // Billing quota exceeded (key is dead, disable it)
    keyPool.disable(req.key!, "quota");
    errorPayload.proxy_note = `Assigned key's quota has been exceeded. ${tryAgainMessage}`;
  } else if (type === "access_terminated") {
    // Account banned (key is dead, disable it)
    keyPool.disable(req.key!, "revoked");
    errorPayload.proxy_note = `Assigned key has been banned by OpenAI for policy violations. ${tryAgainMessage}`;
  } else if (type === "billing_not_active") {
    // Billing is not active (key is dead, disable it)
    keyPool.disable(req.key!, "revoked");
    errorPayload.proxy_note = `Assigned key was deactivated by OpenAI. ${tryAgainMessage}`;
  } else if (type === "requests" || type === "tokens") {
    // Per-minute request or token rate limit is exceeded, which we can retry
    keyPool.markRateLimited(req.key!);
    // I'm aware this is confusing -- throwing this class of error will cause
    // the proxy response handler to return without terminating the request,
    // so that it can be placed back in the queue.
    reenqueueRequest(req);
    throw new RetryableError("Rate-limited request re-enqueued.");
  } else {
    // OpenAI probably overloaded
    errorPayload.proxy_note = `This is likely a temporary error with OpenAI. Try again in a few seconds.`;
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
    if (typeof body !== "object") {
      throw new Error("Expected body to be an object");
    }

    const service = req.outboundApi;
    const { completion } = getCompletionForService({ req, service, body });
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
    req.log.error(
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
