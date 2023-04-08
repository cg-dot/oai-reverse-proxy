import { Request, Response, NextFunction, Router } from "express";
import * as http from "http";
import { createProxyMiddleware } from "http-proxy-middleware";
import { logger } from "./logger";
import { keys } from "./keys";

/**
 * Modifies the request body to add a randomly selected API key.
 */
const rewriteRequest = (proxyReq: http.ClientRequest, req: Request) => {
  const key = keys.get(req.body?.model || "gpt-3.5")!;
  req.key = key;

  proxyReq.setHeader("Authorization", `Bearer ${key}`);
  if (req.body?.stream) {
    req.body.stream = false;
    const updatedBody = JSON.stringify(req.body);
    proxyReq.setHeader("Content-Length", Buffer.byteLength(updatedBody));
    proxyReq.write(updatedBody);
    proxyReq.end();
  }
};

// TODO: extract this since Kobold will use it too
const handleResponse = (
  proxyRes: http.IncomingMessage,
  req: Request,
  res: Response
) => {
  const statusCode = proxyRes.statusCode || 500;

  if (statusCode >= 400) {
    // Consume body and then decide what to do
    let body = "";
    proxyRes.on("data", (chunk) => {
      body += chunk;
    });
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
        logger.error(errorPayload.error, { error: err });
        res.status(statusCode).json(errorPayload);
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
        // - Model overloaded, their server is fucked
        if (errorPayload.error?.type === "insufficient_quota") {
          logger.warn(`OpenAI key is exhausted. Keyhash ${req.key?.hash}`);
          keys.disable(req.key!);
          const message = `The OpenAI key is exhausted. ${canTryAgain}`;
          errorPayload.proxy_note = message;
        } else {
          logger.warn(
            `OpenAI rate limit exceeded or model overloaded. Keyhash ${req.key?.hash}`,
            { errorCode: errorPayload.error?.type }
          );
        }
      }

      res.status(statusCode).json(errorPayload);
    });
  } else {
    proxyRes.pipe(res);
  }
};

const openaiProxy = createProxyMiddleware({
  target: "https://api.openai.com",
  changeOrigin: true,
  onProxyReq: rewriteRequest,
  onProxyRes: handleResponse,
  selfHandleResponse: true,
  pathRewrite: {
    "^/proxy/openai": "",
  },
  logProvider: () => ({
    debug: logger.debug.bind(logger),
    info: logger.info.bind(logger),
    warn: logger.warn.bind(logger),
    error: logger.error.bind(logger),
    log: logger.info.bind(logger),
  }),
});

const openaiRouter = Router();
openaiRouter.post("/v1/chat/completions", openaiProxy);
// openaiRouter.post("/v1/completions", openaiProxy);
// openaiRouter.get("/v1/models", handleModels);
// openaiRouter.get("/dashboard/billing/usage, handleUsage);
openaiRouter.use((req, res) => {
  logger.warn(`Blocked openai proxy request: ${req.method} ${req.path}`);
  res.status(404).json({ error: "Not found" });
});

export const openai = openaiRouter;
