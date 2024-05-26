import { createHash } from "crypto";
import { config } from "../../../config";
import { eventLogger } from "../../../shared/prompt-logging";
import { getModelFromBody, isTextGenerationRequest } from "../common";
import { ProxyResHandlerWithBody } from ".";
import {
  OpenAIChatMessage,
  AnthropicChatMessage,
} from "../../../shared/api-schemas";

/** If event logging is enabled, logs a chat completion event. */
export const logEvent: ProxyResHandlerWithBody = async (
  _proxyRes,
  req,
  _res,
  responseBody
) => {
  if (!config.eventLogging) {
    return;
  }
  if (typeof responseBody !== "object") {
    throw new Error("Expected body to be an object");
  }
  if (!["openai", "anthropic-chat"].includes(req.outboundApi)) {
    // only chat apis are supported
    return;
  }
  if (!req.user) {
    return;
  }

  const loggable = isTextGenerationRequest(req);
  if (!loggable) return;

  const messages = req.body.messages as
    | OpenAIChatMessage[]
    | AnthropicChatMessage[];

  let hashes = [];
  hashes.push(hashMessages(messages));
  for (
    let i = 1;
    i <= Math.min(config.eventLoggingTrim!, messages.length);
    i++
  ) {
    hashes.push(hashMessages(messages.slice(0, -i)));
  }

  const model = getModelFromBody(req, responseBody);
  const userToken = req.user!.token;
  const family = req.modelFamily!;
  eventLogger.logEvent({
    ip: req.ip,
    type: "chat_completion",
    model,
    family,
    hashes,
    userToken,
    inputTokens: req.promptTokens ?? 0,
    outputTokens: req.outputTokens ?? 0,
  });
};

const hashMessages = (
  messages: OpenAIChatMessage[] | AnthropicChatMessage[]
): string => {
  let hasher = createHash("sha256");
  let messageTexts = [];
  for (const msg of messages) {
    if (!["system", "user", "assistant"].includes(msg.role)) continue;
    if (typeof msg.content === "string") {
      messageTexts.push(msg.content);
    } else if (Array.isArray(msg.content)) {
      if (msg.content[0].type === "text") {
        messageTexts.push(msg.content[0].text);
      }
    }
  }
  hasher.update(messageTexts.join("<|im_sep|>"));
  return hasher.digest("hex");
};
