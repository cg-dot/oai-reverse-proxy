import { Request, Response } from "express";
import * as http from "http";
import * as httpProxy from "http-proxy";
import { logger } from "../logger";
import { keys } from "../keys";

/** Handle and rewrite response to proxied requests to OpenAI */
export const handleResponse = (
  proxyRes: http.IncomingMessage,
  req: Request,
  res: Response
) => {
  const statusCode = proxyRes.statusCode || 500;
  if (statusCode >= 400) {
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
      } catch (err) {
        logger.error({ error: err }, errorPayload.error);
        res.json(errorPayload);
        return;
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
      }

      res.status(statusCode).json(errorPayload);
    });
  } else {
    // Increment key's usage count
    keys.incrementPrompt(req.key?.hash);

    Object.keys(proxyRes.headers).forEach((key) => {
      res.setHeader(key, proxyRes.headers[key] as string);
    });
    proxyRes.pipe(res);
  }
};

export const onError: httpProxy.ErrorCallback = (err, _req, res) => {
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
