/* Accepts incoming requests at either the /kobold or /openai routes and then
routes them to the appropriate handler to be forwarded to the OpenAI API.
Incoming OpenAI requests are more or less 1:1 with the OpenAI API, but only a
subset of the API is supported. Kobold requests must be transformed into
equivalent OpenAI requests. */

import * as express from "express";
import { auth } from "./auth";
import { kobold } from "./kobold";
import { openai } from "./openai";

const router = express.Router();

router.use(auth);
router.use("/kobold", kobold);
router.use("/openai", openai);

export { router as proxyRouter };
