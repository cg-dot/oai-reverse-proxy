import { Request, Response } from "express";
import { IncomingMessage } from "http";
import { assertNever } from "./utils";

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

/**
 * Returns an SSE message that looks like a completion event for the service
 * that the request is being proxied to. Used to send error messages to the
 * client in the middle of a streaming request.
 */
export function buildFakeSse(type: string, string: string, req: Request) {
  let fakeEvent;
  const content = `\`\`\`\n[${type}: ${string}]\n\`\`\`\n`;

  switch (req.inboundApi) {
    case "openai":
      fakeEvent = {
        id: "chatcmpl-" + req.id,
        object: "chat.completion.chunk",
        created: Date.now(),
        model: req.body?.model,
        choices: [{ delta: { content }, index: 0, finish_reason: type }],
      };
      break;
    case "openai-text":
      fakeEvent = {
        id: "cmpl-" + req.id,
        object: "text_completion",
        created: Date.now(),
        choices: [
          { text: content, index: 0, logprobs: null, finish_reason: type },
        ],
        model: req.body?.model,
      };
      break;
    case "anthropic":
      fakeEvent = {
        completion: content,
        stop_reason: type,
        truncated: false, // I've never seen this be true
        stop: null,
        model: req.body?.model,
        log_id: "proxy-req-" + req.id,
      };
      break;
    case "google-ai":
    case "openai-image":
      throw new Error(`SSE not supported for ${req.inboundApi} requests`);
    default:
      assertNever(req.inboundApi);
  }

  if (req.inboundApi === "anthropic") {
    return (
      ["event: completion", `data: ${JSON.stringify(fakeEvent)}`].join("\n") +
      "\n\n"
    );
  }

  return `data: ${JSON.stringify(fakeEvent)}\n\n`;
}
