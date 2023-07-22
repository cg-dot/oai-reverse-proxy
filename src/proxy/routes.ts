/* Accepts incoming requests at either the /kobold or /openai routes and then
routes them to the appropriate handler to be forwarded to the OpenAI API.
Incoming OpenAI requests are more or less 1:1 with the OpenAI API, but only a
subset of the API is supported. Kobold requests must be transformed into
equivalent OpenAI requests. */

import * as express from "express";
import { gatekeeper } from "./auth/gatekeeper";
import { checkRisuToken } from "./auth/check-risu-token";
import { kobold } from "./kobold";
import { openai } from "./openai";
import { anthropic } from "./anthropic";

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
proxyRouter.use("/kobold", kobold);
proxyRouter.use("/openai", openai);
proxyRouter.use("/anthropic", anthropic);
export { proxyRouter as proxyRouter };
