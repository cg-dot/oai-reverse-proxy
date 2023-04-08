/* Accepts incoming requests at either the /kobold or /openai routes and then
routes them to the appropriate handler to be forwarded to the OpenAI API.
Incoming openai requests are more or less 1:1 with the OpenAI API, but only a
subset of the API is supported. Kobold requests are more complex and are
translated into OpenAI requests. */

import * as express from "express";
import { auth } from "./auth";
import { kobold } from "./kobold";
import { openai } from "./openai";

const router = express.Router();

router.get("/", (req, res) => {
  res.json({
    message: "OpenAI Reverse Proxy",
    uptime: process.uptime(),
    timestamp: Date.now(),
    kobold: req.protocol + "://" + req.get("host") + "/kobold",
    openai: req.protocol + "://" + req.get("host") + "/openai",
  });
});
router.use(auth);
router.use("/kobold", kobold);
router.use("/openai", openai);

export { router as proxy };
