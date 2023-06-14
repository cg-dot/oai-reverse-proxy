import { isCompletionRequest } from "../common";
import { ProxyRequestMiddleware } from ".";

const DISALLOWED_ORIGIN_SUBSTRINGS = "janitorai.com,janitor.ai".split(",");

class ForbiddenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ForbiddenError";
  }
}

/**
 * Blocks requests from Janitor AI users with a fake, scary error message so I
 * stop getting emails asking for tech support.
 */
export const blockZoomers: ProxyRequestMiddleware = (_proxyReq, req) => {
  if (!isCompletionRequest(req)) {
    return;
  }

  const origin = req.headers.origin || req.headers.referer;
  if (origin && DISALLOWED_ORIGIN_SUBSTRINGS.some((s) => origin.includes(s))) {
    // Venus-derivatives send a test prompt to check if the proxy is working.
    // We don't want to block that just yet.
    if (req.body.messages[0]?.content === "Just say TEST") {
      return;
    }

    throw new ForbiddenError(
      `This OpenAI account has been disabled due to fraud and potential CSAM violations. Your IP address, user agent, and request details have been logged and will be shared with the National Center for Missing and Exploited Children and local law enforcement's cybercrime division to assist in their investigation.`
    );
  }
};
