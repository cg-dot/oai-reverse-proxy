import { Response } from "express";
import { IncomingMessage } from "http";
import { assertNever } from "./utils";
import { APIFormat } from "./key-management";

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
export function makeCompletionSSE({
  format,
  title,
  message,
  obj,
  reqId,
  model = "unknown",
}: {
  format: APIFormat;
  title: string;
  message: string;
  obj?: object;
  reqId: string | number | object;
  model?: string;
}) {
  const id = String(reqId);
  const content = `\n\n**${title}**\n${message}${
    obj ? `\n\`\`\`\n${JSON.stringify(obj, null, 2)}\n\`\`\`\n` : ""
  }`;

  let event;

  switch (format) {
    case "openai":
    case "mistral-ai":
      event = {
        id: "chatcmpl-" + id,
        object: "chat.completion.chunk",
        created: Date.now(),
        model,
        choices: [{ delta: { content }, index: 0, finish_reason: title }],
      };
      break;
    case "openai-text":
      event = {
        id: "cmpl-" + id,
        object: "text_completion",
        created: Date.now(),
        choices: [
          { text: content, index: 0, logprobs: null, finish_reason: title },
        ],
        model,
      };
      break;
    case "anthropic":
      event = {
        completion: content,
        stop_reason: title,
        truncated: false,
        stop: null,
        model,
        log_id: "proxy-req-" + id,
      };
      break;
    case "google-ai":
      return JSON.stringify({
        candidates: [
          {
            content: { parts: [{ text: content }], role: "model" },
            finishReason: title,
            index: 0,
            tokenCount: null,
            safetyRatings: [],
          },
        ],
      });
    case "openai-image":
      throw new Error(`SSE not supported for ${format} requests`);
    default:
      assertNever(format);
  }

  if (format === "anthropic") {
    return (
      ["event: completion", `data: ${JSON.stringify(event)}`].join("\n") +
      "\n\n"
    );
  }

  return `data: ${JSON.stringify(event)}\n\n`;
}
