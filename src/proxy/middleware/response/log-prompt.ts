import { config } from "../../../config";
import { logQueue } from "../../../prompt-logging";
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

  const model = req.body.model;
  const promptFlattened = flattenMessages(req.body.messages);
  const response = getResponseForModel({ model, body: responseBody });

  logQueue.enqueue({
    model,
    endpoint: req.api,
    promptRaw: JSON.stringify(req.body.messages),
    promptFlattened,
    response,
  });
};

type OaiMessage = {
  role: "user" | "assistant" | "system";
  content: string;
};

const flattenMessages = (messages: OaiMessage[]): string => {
  return messages.map((m) => `${m.role}: ${m.content}`).join("\n");
};

const getResponseForModel = ({
  model,
  body,
}: {
  model: string;
  body: Record<string, any>;
}) => {
  if (model.startsWith("claude")) {
    // TODO: confirm if there is supposed to be a leading space
    return body.completion.trim();
  } else {
    return body.choices[0].message.content;
  }
};
