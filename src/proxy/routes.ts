/* Accepts incoming requests at either the /kobold or /openai routes and then
routes them to the appropriate handler to be forwarded to the OpenAI API.
Incoming OpenAI requests are more or less 1:1 with the OpenAI API, but only a
subset of the API is supported. Kobold requests must be transformed into
equivalent OpenAI requests. */

import * as express from "express";
import { gatekeeper } from "./auth/gatekeeper";
import { kobold } from "./kobold";
import { openai } from "./openai";
import { anthropic } from "./anthropic";

const router = express.Router();

router.use(gatekeeper);
router.use("/kobold", kobold);
router.use("/openai", openai);
router.use("/anthropic", anthropic);

// Each client handles the endpoints input by the user in slightly different
// ways, eg TavernAI ignores everything after the hostname in Kobold mode
function rewriteTavernRequests(
  req: express.Request,
  _res: express.Response,
  next: express.NextFunction
) {
  // Requests coming into /api/v1 are actually requests to /proxy/kobold/api/v1
  if (req.path.startsWith("/api/v1")) {
    req.url = req.url.replace("/api/v1", "/proxy/kobold/api/v1");
  }
  next();
}

export { rewriteTavernRequests };
export { router as proxyRouter };
