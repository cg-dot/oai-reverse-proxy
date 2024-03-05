import { Response } from "express";
import { IncomingMessage } from "http";

export function initializeSseStream(res: Response) {
  res.statusCode = 200;
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no"); // nginx-specific fix
  res.flushHeaders();
}

/**
 * Copies headers received from upstream API to the SSE response, excluding
 * ones we need to set ourselves for SSE to work.
 */
export function copySseResponseHeaders(
  proxyRes: IncomingMessage,
  res: Response
) {
  const toOmit = [
    "content-length",
    "content-encoding",
    "transfer-encoding",
    "content-type",
    "connection",
    "cache-control",
  ];
  for (const [key, value] of Object.entries(proxyRes.headers)) {
    if (!toOmit.includes(key) && value) {
      res.setHeader(key, value);
    }
  }
}

