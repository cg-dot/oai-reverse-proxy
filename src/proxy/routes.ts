import express, { Request, Response, NextFunction } from "express";
import { gatekeeper } from "./gatekeeper";
import { checkRisuToken } from "./check-risu-token";
import { openai } from "./openai";
import { anthropic } from "./anthropic";
import { googlePalm } from "./palm";
import { aws } from "./aws";

const proxyRouter = express.Router();
proxyRouter.use(
  express.json({ limit: "1536kb" }),
  express.urlencoded({ extended: true, limit: "1536kb" })
);
proxyRouter.use(gatekeeper);
proxyRouter.use(checkRisuToken);
proxyRouter.use((req, _res, next) => {
  req.startTime = Date.now();
  req.retryCount = 0;
  next();
});
proxyRouter.use("/openai", addV1, openai);
proxyRouter.use("/anthropic", addV1, anthropic);
proxyRouter.use("/google-palm", addV1, googlePalm);
proxyRouter.use("/aws/claude", addV1, aws);
// Redirect browser requests to the homepage.
proxyRouter.get("*", (req, res, next) => {
  const isBrowser = req.headers["user-agent"]?.includes("Mozilla");
  if (isBrowser) {
    res.redirect("/");
  } else {
    next();
  }
});
export { proxyRouter as proxyRouter };

function addV1(req: Request, res: Response, next: NextFunction) {
  // Clients don't consistently use the /v1 prefix so we'll add it for them.
  if (!req.path.startsWith("/v1/")) {
    req.url = `/v1${req.url}`;
  }
  next();
}
