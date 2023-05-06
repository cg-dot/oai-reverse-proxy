import { Request, Response } from "express";
import * as http from "http";
import util from "util";
import zlib from "zlib";
import * as httpProxy from "http-proxy";
import { logger } from "../../../logger";
import { keyPool } from "../../../key-management";
import { logPrompt } from "./log-prompt";
import { handleStreamedResponse } from "./handle-streamed-response";

export const QUOTA_ROUTES = ["/v1/chat/completions"];
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
export const createOnProxyResHandler = (middleware: ProxyResMiddleware) => {
  return async (
    proxyRes: http.IncomingMessage,
    req: Request,
    res: Response
  ) => {
    const initialHandler = req.isStreaming
      ? handleStreamedResponse
      : decodeResponseBody;

    let lastMiddlewareName = initialHandler.name;

    req.log.debug(
      {
        api: req.api,
        route: req.path,
        method: req.method,
        stream: req.isStreaming,
        middleware: lastMiddlewareName,
      },
      "Handling proxy response"
    );

    try {
      const body = await initialHandler(proxyRes, req, res);

      const middlewareStack: ProxyResMiddleware = [];

      if (req.isStreaming) {
        // Anything that touches the response will break streaming requests so
        // certain middleware can't be used. This includes whatever API-specific
        // middleware is passed in, which isn't ideal but it's what we've got
        // for now.
        // Streamed requests will be treated as non-streaming if the upstream
        // service returns a non-200 status code, so no need to include the
        // error handler here.

        // This is a little too easy to accidentally screw up so I need to add a
        // better way to differentiate between middleware that can be used for
        // streaming requests and those that can't. Probably a separate type
        // or function signature for streaming-compatible middleware.
        middlewareStack.push(incrementKeyUsage, logPrompt);
      } else {
        middlewareStack.push(
          handleUpstreamErrors,
          incrementKeyUsage,
          copyHttpHeaders,
          logPrompt,
          ...middleware
        );
      }

      for (const middleware of middlewareStack) {
        lastMiddlewareName = middleware.name;
        await middleware(proxyRes, req, res, body);
      }
    } catch (error: any) {
      if (res.headersSent) {
        req.log.error(
          `Error while executing proxy response middleware: ${lastMiddlewareName} (${error.message})`
        );
        // Either the upstream error handler got to it first, or we're mid-
        // stream and we can't do anything about it.
        return;
      }

      const message = `Error while executing proxy response middleware: ${lastMiddlewareName} (${error.message})`;
      logger.error(
        {
          error: error.stack,
          thrownBy: lastMiddlewareName,
          key: req.key?.hash,
        },
        message
      );
      res
        .status(500)
        .json({ error: "Internal server error", proxy_note: message });
    }
  };
};

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
    req.log.error(
      { api: req.api, key: req.key?.hash },
      `decodeResponseBody called for a streaming request, which isn't valid.`
    );
    throw new Error("decodeResponseBody called for a streaming request.");
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
          res.status(500).json({ error: errorMessage, contentEncoding });
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
        res.status(500).json({ error: errorMessage });
        return reject(errorMessage);
      }
    });
  });
  return promise;
};

// TODO: This is too specific to OpenAI's error responses, Anthropic errors
// will need a different handler.
/**
 * Handles non-2xx responses from the upstream service.  If the proxied response
 * is an error, this will respond to the client with an error payload and throw
 * an error to stop the middleware stack.
 * @throws {Error} HTTP error status code from upstream service
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
  const availableKeys = keyPool.available() - 1;
  const tryAgainMessage = Boolean(availableKeys)
    ? `There are ${availableKeys} more keys available; try your request again.`
    : "There are no more keys available.";

  try {
    if (typeof body === "object") {
      errorPayload = body;
    } else {
      throw new Error("Received non-JSON error response from upstream.");
    }
  } catch (parseError: any) {
    const statusMessage = proxyRes.statusMessage || "Unknown error";
    // Likely Bad Gateway or Gateway Timeout from OpenAI's Cloudflare proxy
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

    res.status(statusCode).json(errorObject);
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
    errorPayload.proxy_note = `OpenAI rejected the request as invalid. Your prompt may be too long for ${req.body?.model}.`;
  } else if (statusCode === 401) {
    // Key is invalid or was revoked
    keyPool.disable(req.key!);
    errorPayload.proxy_note = `The OpenAI key is invalid or revoked. ${tryAgainMessage}`;
  } else if (statusCode === 429) {
    // One of:
    // - Quota exceeded (key is dead, disable it)
    // - Rate limit exceeded (key is fine, just try again)
    // - Model overloaded (their fault, just try again)
    if (errorPayload.error?.type === "insufficient_quota") {
      keyPool.disable(req.key!);
      errorPayload.proxy_note = `Assigned key's quota has been exceeded. ${tryAgainMessage}`;
    } else if (errorPayload.error?.type === "billing_not_active") {
      keyPool.disable(req.key!);
      errorPayload.proxy_note = `Assigned key was deactivated by OpenAI. ${tryAgainMessage}`;
    } else {
      errorPayload.proxy_note = `This is likely a temporary error with OpenAI. Try again in a few seconds.`;
    }
  } else if (statusCode === 404) {
    // Most likely model not found
    if (errorPayload.error?.code === "model_not_found") {
      if (req.key!.isGpt4) {
        // Malicious users can request a model that `startsWith` gpt-4 but is
        // not actually a valid model name and force the key to be downgraded.
        // I don't feel like fixing this so I'm just going to disable the key
        // downgrading feature for now.
        // keyPool.downgradeKey(req.key?.hash);
        // errorPayload.proxy_note = `This key was incorrectly assigned to GPT-4. It has been downgraded to Turbo.`;
        errorPayload.proxy_note = `This key was incorrectly flagged as GPT-4, or you requested a GPT-4 snapshot for which this key is not authorized. Try again to get a different key, or use Turbo.`;
      } else {
        errorPayload.proxy_note = `No model was found for this key.`;
      }
    }
  } else {
    errorPayload.proxy_note = `Unrecognized error from OpenAI.`;
  }

  // Some OAI errors contain the organization ID, which we don't want to reveal.
  if (errorPayload.error?.message) {
    errorPayload.error.message = errorPayload.error.message.replace(
      /org-.{24}/gm,
      "org-xxxxxxxxxxxxxxxxxxx"
    );
  }

  res.status(statusCode).json(errorPayload);
  throw new Error(errorPayload.error?.message);
};

/** Handles errors in rewriter pipelines. */
export const handleInternalError: httpProxy.ErrorCallback = (
  err,
  _req,
  res
) => {
  logger.error({ error: err }, "Error in http-proxy-middleware pipeline.");
  try {
    if ("setHeader" in res && !res.headersSent) {
      res.writeHead(500, { "Content-Type": "application/json" });
    }
    res.end(
      JSON.stringify({
        error: {
          type: "proxy_error",
          message: err.message,
          stack: err.stack,
          proxy_note: `Reverse proxy encountered an error before it could reach the upstream API.`,
        },
      })
    );
  } catch (e) {
    logger.error(
      { error: e },
      `Error writing error response headers, giving up.`
    );
  }
};

const incrementKeyUsage: ProxyResHandlerWithBody = async (_proxyRes, req) => {
  if (QUOTA_ROUTES.includes(req.path)) {
    keyPool.incrementPrompt(req.key?.hash);
  }
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
