/**
 * Authenticates RisuAI.xyz users using a special x-risu-tk header provided by
 * RisuAI.xyz. This lets us rate limit and limit queue concurrency properly,
 * since otherwise RisuAI.xyz users share the same IP address and can't be
 * distinguished.
 * Contributors: @kwaroran
 */

import axios from "axios";
import { Request, Response, NextFunction } from "express";

const RISUAI_TOKEN_CHECKER_URL = "https://sv.risuai.xyz/public/api/checktoken";
const validRisuTokens = new Set<string>();
let lastFailedRisuTokenCheck = 0;

export async function checkRisuToken(
  req: Request,
  _res: Response,
  next: NextFunction
) {
  let header = req.header("x-risu-tk") || null;
  if (!header) {
    return next();
  }

  const timeSinceLastFailedCheck = Date.now() - lastFailedRisuTokenCheck;
  if (timeSinceLastFailedCheck < 60 * 1000) {
    req.log.warn(
      { timeSinceLastFailedCheck },
      "Skipping RisuAI token check due to recent failed check"
    );
    return next();
  }

  try {
    if (!validRisuTokens.has(header)) {
      req.log.info("Authenticating new RisuAI token");
      const validCheck = await axios.post<{ vaild: boolean }>(
        RISUAI_TOKEN_CHECKER_URL,
        { token: header },
        { headers: { "Content-Type": "application/json" } }
      );

      if (!validCheck.data.vaild) {
        req.log.warn("Invalid RisuAI token; using IP instead");
      } else {
        req.log.info("RisuAI token authenticated");
        validRisuTokens.add(header);
        req.risuToken = header;
      }
    } else {
      req.log.debug("RisuAI token already known");
      req.risuToken = header;
    }
  } catch (err) {
    lastFailedRisuTokenCheck = Date.now();
    req.log.warn(
      { error: err.message },
      "Error authenticating RisuAI token; using IP instead"
    );
  }

  next();
}
