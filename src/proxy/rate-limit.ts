import { Request, Response, NextFunction } from "express";
import { config } from "../config";
import { logger } from "../logger";

export const AGNAI_DOT_CHAT_IP = "157.230.249.32";
const RATE_LIMIT_ENABLED = Boolean(config.modelRateLimit);
const RATE_LIMIT = Math.max(1, config.modelRateLimit);
const ONE_MINUTE_MS = 60 * 1000;

const lastAttempts = new Map<string, number[]>();

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

/** Prunes attempts and IPs that are no longer relevant after five minutes. */
const clearOldAttempts = () => {
  const uniqueIps = lastAttempts.size;
  for (const [ip, attempts] of lastAttempts.entries()) {
    const validAttempts = attempts.filter(expireOldAttempts(Date.now()));
    if (validAttempts.length === 0) {
      lastAttempts.delete(ip);
    } else {
      lastAttempts.set(ip, validAttempts);
    }
  }
  const prunedIps = uniqueIps - lastAttempts.size;
  logger.info(
    { activeIps: lastAttempts.size, prunedIps },
    "Cleaned up rate limit map"
  );
};
setInterval(clearOldAttempts, 5 * ONE_MINUTE_MS);

export const getUniqueIps = () => {
  return lastAttempts.size;
};

export const ipLimiter = (req: Request, res: Response, next: NextFunction) => {
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

  const { remaining, reset } = getStatus(req.ip);
  res.set("X-RateLimit-Limit", config.modelRateLimit.toString());
  res.set("X-RateLimit-Remaining", remaining.toString());
  res.set("X-RateLimit-Reset", reset.toString());

  const tryAgainInMs = getTryAgainInMs(req.ip);
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
