import { config } from "../config";
import { RequestHandler } from "express";

const BLOCKED_REFERERS = config.blockedOrigins?.split(",") || [];

/** Disallow requests from blocked origins and referers. */
export const checkOrigin: RequestHandler = (req, res, next) => {
  const blocks = BLOCKED_REFERERS || [];
  for (const block of blocks) {
    if (
      req.headers.origin?.includes(block) ||
      req.headers.referer?.includes(block)
    ) {
      req.log.warn(
        { origin: req.headers.origin, referer: req.headers.referer },
        "Blocked request from origin or referer"
      );
      if (!req.accepts("html") || req.headers.accept === "*/*") {
        return res.status(403).json({
          error: { type: "blocked_origin", message: config.blockMessage },
        });
      } else {
        const destination = config.blockRedirect || "https://openai.com";
        return res.status(403).send(
          `<html>
<head>
  <title>Redirecting</title>
  <meta http-equiv="refresh" content="3; url=${destination}" />
</head>
<body style="font-family: sans-serif; height: 100vh; display: flex; flex-direction: column; justify-content: center; text-align: center;">
<h2>${config.blockMessage}</h3>
<p><strong>Please hold while you are redirected to a more suitable service.</strong></p>
</body>
</html>`
        );
      }
    }
  }
  next();
};
