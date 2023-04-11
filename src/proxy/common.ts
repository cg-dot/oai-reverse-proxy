import { Request, Response } from "express";
import * as http from "http";
import util from "util";
import zlib from "zlib";
import * as httpProxy from "http-proxy";
import { logger } from "../logger";
import { keyPool } from "../key-management";

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

    let chunks: Buffer[] = [];
    proxyRes.on("data", (chunk) => chunks.push(chunk));
    proxyRes.on("end", async () => {
      let body = Buffer.concat(chunks);
      const contentEncoding = proxyRes.headers["content-encoding"];

      if (contentEncoding === "gzip") {
        body = await util.promisify(zlib.gunzip)(body);
      } else if (contentEncoding === "deflate") {
        body = await util.promisify(zlib.inflate)(body);
      }

      const bodyString = body.toString();

      let errorPayload: any = { error: "If you see this, something is wrong." };
      const availableKeys = keyPool.available();
      const canTryAgain = Boolean(availableKeys)
        ? `There are ${availableKeys} more keys available; try your request again.`
        : "There are no more keys available.";

      try {
        errorPayload = JSON.parse(bodyString);
      } catch (parseError: any) {
        const statusMessage = proxyRes.statusMessage || "Unknown error";
        // Likely Bad Gateway or Gateway Timeout from OpenAI's Cloudflare proxy
        logger.warn(
          { statusCode, statusMessage, key: req.key?.hash },
          "Received non-JSON error response from OpenAI."
        );

        const errorObject = {
          statusCode,
          statusMessage: proxyRes.statusMessage,
          error: parseError.message,
          proxy_note: "This is likely a temporary error with OpenAI.",
        };

        res.json(errorObject);
        return reject(parseError.message);
      }

      // From here on we know we have a JSON error payload from OpenAI and can
      // tack on our own error messages to it.

      if (statusCode === 401) {
        // Key is invalid or was revoked
        logger.warn(
          `OpenAI key is invalid or revoked. Keyhash ${req.key?.hash}`
        );
        keyPool.disable(req.key!);
        const message = `The OpenAI key is invalid or revoked. ${canTryAgain}`;
        errorPayload.proxy_note = message;
      } else if (statusCode === 429) {
        // One of:
        // - Quota exceeded (key is dead, disable it)
        // - Rate limit exceeded (key is fine, just try again)
        // - Model overloaded (their fault, just try again)
        if (errorPayload.error?.type === "insufficient_quota") {
          logger.warn(
            { error: errorPayload, key: req.key?.hash },
            "OpenAI key quota exceeded."
          );
          keyPool.disable(req.key!);
          errorPayload.proxy_note = `Assigned key's quota has been exceeded. ${canTryAgain}`;
        } else {
          logger.warn(
            { error: errorPayload, key: req.key?.hash },
            `OpenAI rate limit exceeded or model overloaded.`
          );
          errorPayload.proxy_note = `This is likely a temporary error with OpenAI. Try again in a few seconds.`;
        }
      } else if (statusCode === 404) {
        // Most likely model not found
        if (errorPayload.error?.code === "model_not_found") {
          if (req.key!.isGpt4) {
            keyPool.downgradeKey(req.key?.hash);
            errorPayload.proxy_note = `This key was incorrectly assigned to GPT-4. It has been downgraded to Turbo.`;
          } else {
            errorPayload.proxy_note = `No model was found for this key.`;
          }
        }
      } else {
        logger.error(
          { error: errorPayload, key: req.key?.hash, statusCode },
          `Unrecognized error from OpenAI.`
        );
        errorPayload.proxy_note = `Unrecognized error from OpenAI.`;
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
    keyPool.incrementPrompt(req.key?.hash);
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
