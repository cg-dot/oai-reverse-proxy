import { config } from "../../config";
import type { ExpressHttpProxyReqCallback } from ".";
import { logger } from "../../logger";

const DISALLOWED_REGEX =
  /[\u2E80-\u2E99\u2E9B-\u2EF3\u2F00-\u2FD5\u3005\u3007\u3021-\u3029\u3038-\u303B\u3400-\u4DB5\u4E00-\u9FD5\uF900-\uFA6D\uFA70-\uFAD9]/;

// Our shitty free-tier will fall over if we test every single character in each
// 15k character request ten times a second. So we'll just sample 20% of the
// characters and hope that's enough.
const containsDisallowedCharacters = (text: string) => {
  const sampleSize = Math.ceil(text.length * (config.rejectSampleRate || 0.2));
  const sample = text
    .split("")
    .sort(() => 0.5 - Math.random())
    .slice(0, sampleSize)
    .join("");
  return DISALLOWED_REGEX.test(sample);
};

/** Block requests containing too many disallowed characters. */
export const languageFilter: ExpressHttpProxyReqCallback = (_proxyReq, req) => {
  if (!config.rejectDisallowed) {
    return;
  }

  if (req.method === "POST" && req.body?.messages) {
    const combinedText = req.body.messages
      .map((m: { role: string; content: string }) => m.content)
      .join(",");
    if (containsDisallowedCharacters(combinedText)) {
      logger.warn(`Blocked request containing bad characters`);
      _proxyReq.destroy(new Error(config.rejectMessage));
    }
  }
};
