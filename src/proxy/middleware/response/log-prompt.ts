import { Request } from "express";
import { config } from "../../../config";
import { logQueue } from "../../../shared/prompt-logging";
import { getCompletionForService, isCompletionRequest } from "../common";
import { ProxyResHandlerWithBody } from ".";

/** If prompt logging is enabled, enqueues the prompt for logging. */
export const logPrompt: ProxyResHandlerWithBody = async (
  _proxyRes,
  req,
  _res,
  responseBody
) => {
  if (!config.promptLogging) {
    return;
  }
  if (typeof responseBody !== "object") {
    throw new Error("Expected body to be an object");
  }

  if (!isCompletionRequest(req)) {
    return;
  }

  const promptPayload = getPromptForRequest(req);
  const promptFlattened = flattenMessages(promptPayload);
  const response = getCompletionForService({
    service: req.outboundApi,
    body: responseBody,
  });

  logQueue.enqueue({
    endpoint: req.inboundApi,
    promptRaw: JSON.stringify(promptPayload),
    promptFlattened,
    model: response.model, // may differ from the requested model
    response: response.completion,
  });
};

type OaiMessage = {
  role: "user" | "assistant" | "system";
  content: string;
};

const getPromptForRequest = (req: Request): string | OaiMessage[] => {
  // Since the prompt logger only runs after the request has been proxied, we
  // can assume the body has already been transformed to the target API's
  // format.
  if (req.outboundApi === "anthropic") {
    return req.body.prompt;
  } else {
    return req.body.messages;
  }
};

const flattenMessages = (messages: string | OaiMessage[]): string => {
  if (typeof messages === "string") {
    return messages.trim();
  }
  return messages.map((m) => `${m.role}: ${m.content}`).join("\n");
};
