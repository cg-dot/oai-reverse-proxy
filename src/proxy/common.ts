import { Request, Response } from "express";
import * as http from "http";
import * as httpProxy from "http-proxy";
import { logger } from "../logger";
import { keys } from "../keys";

export const QUOTA_ROUTES = ["/v1/chat/completions"];

/** Check for errors in the response from OpenAI and handle them. */
// This is a mess of promises, callbacks and event listeners because none of
// this low-level nodejs http is async/await friendly.
export const handleDownstreamErrors = (
  proxyRes: http.IncomingMessage,
  req: Request,
  res: Response
) => {
  const promise = new Promise<void>((resolve, reject) => {
    const statusCode = proxyRes.statusCode || 500;
    if (statusCode < 400) {
      return resolve();
    }

    let body = "";
    proxyRes.on("data", (chunk) => (body += chunk));
    proxyRes.on("end", () => {
      let errorPayload: any = {
        error: "Proxy couldn't parse error from OpenAI",
      };
      const canTryAgain = keys.anyAvailable()
        ? "You can try again to get a different key."
        : "There are no more keys available.";
      try {
        errorPayload = JSON.parse(body);
      } catch (parseError: any) {
        const errorObject = {
          error: parseError.message,
          trace:  parseError.stack,
          body: body,
        }
        
        logger.error(errorObject, "Unparseable error from OpenAI");
        res.json(errorObject);
        return reject(parseError.message);
      }

      if (statusCode === 401) {
        // Key is invalid or was revoked
        logger.warn(
          `OpenAI key is invalid or revoked. Keyhash ${req.key?.hash}`
        );
        keys.disable(req.key!);
        const message = `The OpenAI key is invalid or revoked. ${canTryAgain}`;
        errorPayload.proxy_note = message;
      } else if (statusCode === 429) {
        // Rate limit exceeded
        // Annoyingly they send this for:
        // - Quota exceeded, key is totally dead
        // - Rate limit exceeded, key is still good but backoff needed
        // - Model overloaded, their server is overloaded
        if (errorPayload.error?.type === "insufficient_quota") {
          logger.warn(`OpenAI key is exhausted. Keyhash ${req.key?.hash}`);
          keys.disable(req.key!);
          const message = `The OpenAI key is exhausted. ${canTryAgain}`;
          errorPayload.proxy_note = message;
        } else {
          logger.warn(
            { errorCode: errorPayload.error?.type },
            `OpenAI rate limit exceeded or model overloaded. Keyhash ${req.key?.hash}`
          );
        }
      } else if (statusCode === 404) {
        // Most likely model not found
        if (errorPayload.error?.code === "model_not_found") {
          if (req.key!.isGpt4) {
            keys.downgradeKey(req.key?.hash);
          }
          errorPayload.proxy_note =
            "This key may have been incorrectly flagged as gpt-4 enabled.";
        }
      } else {
        logger.error(
          { error: errorPayload },
          `Unexpected error from OpenAI. Keyhash ${req.key?.hash}`
        );
      }
      res.status(statusCode).json(errorPayload);
      reject(errorPayload);
    });
  });
  return promise;
};

/** Handles errors in the request rewrite pipeline before proxying to OpenAI. */
export const handleInternalError: httpProxy.ErrorCallback = (
  err,
  _req,
  res
) => {
  logger.error({ error: err }, "Error proxying to OpenAI");

  (res as http.ServerResponse).writeHead(500, {
    "Content-Type": "application/json",
  });
  res.end(
    JSON.stringify({
      error: {
        type: "proxy_error",
        message: err.message,
        proxy_note:
          "Reverse proxy encountered an error before it could reach OpenAI.",
      },
    })
  );
};

export const incrementKeyUsage = (req: Request) => {
  if (QUOTA_ROUTES.includes(req.path)) {
    keys.incrementPrompt(req.key?.hash);
  }
};

export const copyHttpHeaders = (
  proxyRes: http.IncomingMessage,
  res: Response
) => {
  Object.keys(proxyRes.headers).forEach((key) => {
    res.setHeader(key, proxyRes.headers[key] as string);
  });
};
