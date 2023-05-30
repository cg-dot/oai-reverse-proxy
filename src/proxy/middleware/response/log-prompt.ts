import { Request } from "express";
import { config } from "../../../config";
import { AIService } from "../../../key-management";
import { logQueue } from "../../../prompt-logging";
import { isCompletionRequest } from "../request";
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
  const response = getResponseForService({
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
    return messages;
  }
  return messages.map((m) => `${m.role}: ${m.content}`).join("\n");
};

const getResponseForService = ({
  service,
  body,
}: {
  service: AIService;
  body: Record<string, any>;
}): { completion: string; model: string } => {
  if (service === "anthropic") {
    return { completion: body.completion.trim(), model: body.model };
  } else {
    return { completion: body.choices[0].message.content, model: body.model };
  }
};
