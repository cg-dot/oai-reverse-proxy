/* This file is fucking horrendous, sorry */
import { Request, Response } from "express";
import * as http from "http";
import * as httpProxy from "http-proxy";
import util from "util";
import zlib from "zlib";
import { ZodError } from "zod";
import { config } from "../../../config";
import { logger } from "../../../logger";
import { keyPool } from "../../../key-management";
import { incrementPromptCount } from "../../auth/user-store";
import { buildFakeSseMessage, enqueue, trackWaitTime } from "../../queue";
import { isCompletionRequest } from "../request";
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
        middlewareStack.push(trackRateLimit, incrementKeyUsage, logPrompt);
      } else {
        middlewareStack.push(
          trackRateLimit,
          handleUpstreamErrors,
          incrementKeyUsage,
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
    `Re-enqueueing request due to rate-limit error`
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
    errorPayload.proxy_note = `Upstream service rejected the request as invalid. Your prompt may be too long for ${req.body?.model}.`;
  } else if (statusCode === 401) {
    // Key is invalid or was revoked
    keyPool.disable(req.key!);
    errorPayload.proxy_note = `API key is invalid or revoked. ${tryAgainMessage}`;
  } else if (statusCode === 429) {
    // OpenAI uses this for a bunch of different rate-limiting scenarios.
    if (req.outboundApi === "openai") {
      handleOpenAIRateLimitError(req, tryAgainMessage, errorPayload);
    } else {
      handleAnthropicRateLimitError(req, errorPayload);
    }
  } else if (statusCode === 404) {
    // Most likely model not found
    if (req.outboundApi === "openai") {
      // TODO: this probably doesn't handle GPT-4-32k variants properly if the
      // proxy has keys for both the 8k and 32k context models at the same time.
      if (errorPayload.error?.code === "model_not_found") {
        if (req.key!.isGpt4) {
          errorPayload.proxy_note = `Assigned key isn't provisioned for the GPT-4 snapshot you requested. Try again to get a different key, or use Turbo.`;
        } else {
          errorPayload.proxy_note = `No model was found for this key.`;
        }
      }
    } else if (req.outboundApi === "anthropic") {
      errorPayload.proxy_note = `The requested Claude model might not exist, or the key might not be provisioned for it.`;
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

function handleAnthropicRateLimitError(
  req: Request,
  errorPayload: Record<string, any>
) {
  if (errorPayload.error?.type === "rate_limit_error") {
    keyPool.markRateLimited(req.key!);
    if (config.queueMode !== "none") {
      reenqueueRequest(req);
      throw new RetryableError("Claude rate-limited request re-enqueued.");
    }
    errorPayload.proxy_note = `There are too many in-flight requests for this key. Try again later.`;
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
    keyPool.disable(req.key!);
    errorPayload.proxy_note = `Assigned key's quota has been exceeded. ${tryAgainMessage}`;
  } else if (type === "billing_not_active") {
    // Billing is not active (key is dead, disable it)
    keyPool.disable(req.key!);
    errorPayload.proxy_note = `Assigned key was deactivated by OpenAI. ${tryAgainMessage}`;
  } else if (type === "requests" || type === "tokens") {
    // Per-minute request or token rate limit is exceeded, which we can retry
    keyPool.markRateLimited(req.key!);
    if (config.queueMode !== "none") {
      reenqueueRequest(req);
      // This is confusing, but it will bubble up to the top-level response
      // handler and cause the request to go back into the request queue.
      throw new RetryableError("Rate-limited request re-enqueued.");
    }
    errorPayload.proxy_note = `Assigned key's '${type}' rate limit has been exceeded. Try again later.`;
  } else {
    // OpenAI probably overloaded
    errorPayload.proxy_note = `This is likely a temporary error with OpenAI. Try again in a few seconds.`;
  }
  return errorPayload;
}

function writeErrorResponse(
  req: Request,
  res: Response,
  statusCode: number,
  errorPayload: Record<string, any>
) {
  const errorSource = errorPayload.error?.type.startsWith("proxy")
    ? "proxy"
    : "upstream";

  // If we're mid-SSE stream, send a data event with the error payload and end
  // the stream. Otherwise just send a normal error response.
  if (
    res.headersSent ||
    res.getHeader("content-type") === "text/event-stream"
  ) {
    const msg = buildFakeSseMessage(
      `${errorSource} error (${statusCode})`,
      JSON.stringify(errorPayload, null, 2),
      req
    );
    res.write(msg);
    res.write(`data: [DONE]\n\n`);
    res.end();
  } else {
    res.status(statusCode).json(errorPayload);
  }
}

/** Handles errors in rewriter pipelines. */
export const handleInternalError: httpProxy.ErrorCallback = (err, req, res) => {
  logger.error({ error: err }, "Error in http-proxy-middleware pipeline.");

  try {
    const isZod = err instanceof ZodError;
    if (isZod) {
      writeErrorResponse(req as Request, res as Response, 400, {
        error: {
          type: "proxy_validation_error",
          proxy_note: `Reverse proxy couldn't validate your request when trying to transform it. Your client may be sending invalid data.`,
          issues: err.issues,
          stack: err.stack,
          message: err.message,
        },
      });
    } else {
      writeErrorResponse(req as Request, res as Response, 500, {
        error: {
          type: "proxy_rewriter_error",
          proxy_note: `Reverse proxy encountered an error before it could reach the upstream API.`,
          message: err.message,
          stack: err.stack,
        },
      });
    }
  } catch (e) {
    logger.error(
      { error: e },
      `Error writing error response headers, giving up.`
    );
  }
};

const incrementKeyUsage: ProxyResHandlerWithBody = async (_proxyRes, req) => {
  if (isCompletionRequest(req)) {
    keyPool.incrementPrompt(req.key!);
    if (req.user) {
      incrementPromptCount(req.user.token);
    }
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
