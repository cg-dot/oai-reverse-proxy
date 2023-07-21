import axios from "axios";
import { Request, Response, NextFunction } from "express";
import { config } from "../config";

export const AGNAI_DOT_CHAT_IP = "157.230.249.32";
const RISUAI_TOKEN_CHECKER_URL = "https://sv.risuai.xyz/public/api/checktoken";
const RATE_LIMIT_ENABLED = Boolean(config.modelRateLimit);
const RATE_LIMIT = Math.max(1, config.modelRateLimit);
const ONE_MINUTE_MS = 60 * 1000;

const lastAttempts = new Map<string, number[]>();
const validRisuTokens = new Set<string>();

const expireOldAttempts = (now: number) => (attempt: number) =>
  attempt > now - ONE_MINUTE_MS;

const getTryAgainInMs = (ip: string) => {
  const now = Date.now();
  const attempts = lastAttempts.get(ip) || [];
  const validAttempts = attempts.filter(expireOldAttempts(now));

  if (validAttempts.length >= RATE_LIMIT) {
    return validAttempts[0] - now + ONE_MINUTE_MS;
  } else {
    lastAttempts.set(ip, [...validAttempts, now]);
    return 0;
  }
};

const getStatus = (ip: string) => {
  const now = Date.now();
  const attempts = lastAttempts.get(ip) || [];
  const validAttempts = attempts.filter(expireOldAttempts(now));
  return {
    remaining: Math.max(0, RATE_LIMIT - validAttempts.length),
    reset: validAttempts.length > 0 ? validAttempts[0] + ONE_MINUTE_MS : now,
  };
};

/** Prunes attempts and IPs that are no longer relevant after one minutes. */
const clearOldAttempts = () => {
  const now = Date.now();
  for (const [ip, attempts] of lastAttempts.entries()) {
    const validAttempts = attempts.filter(expireOldAttempts(now));
    if (validAttempts.length === 0) {
      lastAttempts.delete(ip);
    } else {
      lastAttempts.set(ip, validAttempts);
    }
  }
};
setInterval(clearOldAttempts, 10 * 1000);

export const getUniqueIps = () => {
  return lastAttempts.size;
};

export const ipLimiter = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  if (!RATE_LIMIT_ENABLED) {
    next();
    return;
  }

  // Exempt Agnai.chat from rate limiting since it's shared between a lot of
  // users. Dunno how to prevent this from being abused without some sort of
  // identifier sent from Agnaistic to identify specific users.
  if (req.ip === AGNAI_DOT_CHAT_IP) {
    next();
    return;
  }

  // makes risuai.xyz rate limiting by x-risu-tk header since it's shared between a lot of users.
  let risuToken = req.header("x-risu-tk") || null;
  if (risuToken) {
    try {
      // checks the token only when it is not in freshRisuTokens or bitFreshRisuTokens
      if (!validRisuTokens.has(risuToken)) {
        req.log.info(
          { token: `${risuToken.slice(0, 4)}...` },
          "Authenticating new RisuAI token"
        );
        // checks the token is vaild (fresh) to prevend abuse
        const validCheck = await axios.post<{ vaild: boolean }>(
          RISUAI_TOKEN_CHECKER_URL,
          { token: risuToken },
          { headers: { "Content-Type": "application/json" } }
        );

        if (!validCheck.data.vaild) {
          //if its invaild, uses ip instead
          req.log.warn("Invalid RisuAI token; rate limiting by IP instead");
          risuToken = null;
        } else {
          req.log.info("RisuAI token authenticated; adding to known tokens");
          validRisuTokens.add(risuToken);
        }
      }
    } catch (e: any) {
      //if request throws error, uses ip
      // TODO: probably need a backoff here to avoid spamming RisuAI
      req.log.warn(
        { error: e.message },
        "Error authenticating RisuAI token; rate limiting by IP instead"
      );
      risuToken = null;
    }
  }

  // If user is authenticated, key rate limiting by their token. Otherwise, key
  // rate limiting by their IP address. Mitigates key sharing.
  const rateLimitKey = req.user?.token || risuToken || req.ip;

  const { remaining, reset } = getStatus(rateLimitKey);
  res.set("X-RateLimit-Limit", config.modelRateLimit.toString());
  res.set("X-RateLimit-Remaining", remaining.toString());
  res.set("X-RateLimit-Reset", reset.toString());

  const tryAgainInMs = getTryAgainInMs(rateLimitKey);
  if (tryAgainInMs > 0) {
    res.set("Retry-After", tryAgainInMs.toString());
    res.status(429).json({
      error: {
        type: "proxy_rate_limited",
        message: `This proxy is rate limited to ${
          config.modelRateLimit
        } model requests per minute. Please try again in ${Math.ceil(
          tryAgainInMs / 1000
        )} seconds.`,
      },
    });
  } else {
    next();
  }
};
