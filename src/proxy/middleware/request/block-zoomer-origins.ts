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
export const blockZoomerOrigins: ProxyRequestMiddleware = (_proxyReq, req) => {
  const origin = req.headers.origin || req.headers.referer;
  if (origin && DISALLOWED_ORIGIN_SUBSTRINGS.some((s) => origin.includes(s))) {
    // Venus-derivatives send a test prompt to check if the proxy is working.
    // We don't want to block that just yet.
    if (req.body.messages[0]?.content === "Just say TEST") {
      return;
    }

    throw new ForbiddenError(
      `Your access was terminated due to violation of our policies, please check your email for more information. If you believe this is in error and would like to appeal, please contact us through our help center at help.openai.com.`
    );
  }
};
