import { Request } from "express";
import { config } from "../../../config";
import { logger } from "../../../logger";
import { assertNever } from "../../../shared/utils";
import { isCompletionRequest } from "../common";
import { ProxyRequestMiddleware } from ".";

const DISALLOWED_REGEX =
  /[\u2E80-\u2E99\u2E9B-\u2EF3\u2F00-\u2FD5\u3005\u3007\u3021-\u3029\u3038-\u303B\u3400-\u4DB5\u4E00-\u9FD5\uF900-\uFA6D\uFA70-\uFAD9]/;

// Our shitty free-tier VMs will fall over if we test every single character in
// each 15k character request ten times a second. So we'll just sample 20% of
// the characters and hope that's enough.
const containsDisallowedCharacters = (text: string) => {
  const sampleSize = Math.ceil(text.length * 0.2);
  const sample = text
    .split("")
    .sort(() => 0.5 - Math.random())
    .slice(0, sampleSize)
    .join("");
  return DISALLOWED_REGEX.test(sample);
};

/** Block requests containing too many disallowed characters. */
export const languageFilter: ProxyRequestMiddleware = (_proxyReq, req) => {
  if (!config.rejectDisallowed) {
    return;
  }

  if (isCompletionRequest(req)) {
    const combinedText = getPromptFromRequest(req);
    if (containsDisallowedCharacters(combinedText)) {
      logger.warn(`Blocked request containing bad characters`);
      _proxyReq.destroy(new Error(config.rejectMessage));
    }
  }
};

function getPromptFromRequest(req: Request) {
  const service = req.outboundApi;
  const body = req.body;
  switch (service) {
    case "anthropic":
      return body.prompt;
    case "openai":
      return body.messages
        .map((m: { content: string }) => m.content)
        .join("\n");
    case "openai-text":
      return body.prompt;
    case "google-palm":
      return body.prompt.text;
    default:
      assertNever(service);
  }
}
