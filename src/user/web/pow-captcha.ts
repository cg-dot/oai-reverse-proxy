import crypto from "crypto";
import express from "express";
import argon2 from "@node-rs/argon2";
import { z } from "zod";
import { createUser, getUser, upsertUser } from "../../shared/users/user-store";
import { config } from "../../config";

/** HMAC key for signing challenges; regenerated on startup */
const HMAC_KEY = crypto.randomBytes(32).toString("hex");
/** Expiry time for a challenge in milliseconds */
const POW_EXPIRY = 1000 * 60 * 30; // 30 minutes
/** Lockout time after verification in milliseconds */
const LOCKOUT_TIME = 1000 * 60; // 60 seconds

const argon2Params = {
  ARGON2_TIME_COST: parseInt(process.env.ARGON2_TIME_COST || "8"),
  ARGON2_MEMORY_KB: parseInt(process.env.ARGON2_MEMORY_KB || String(1024 * 64)),
  ARGON2_PARALLELISM: parseInt(process.env.ARGON2_PARALLELISM || "1"),
  ARGON2_HASH_LENGTH: parseInt(process.env.ARGON2_HASH_LENGTH || "32"),
};

/**
 * Work factor for each difficulty. This is the expected number of hashes that
 * will be computed to solve the challenge, on average. The actual number of
 * hashes will vary due to randomness.
 */
const workFactors = { extreme: 4000, high: 1900, medium: 900, low: 200 };

type Challenge = {
  /** Salt */
  s: string;
  /** Argon2 hash length */
  hl: number;
  /** Argon2 time cost */
  t: number;
  /** Argon2 memory cost */
  m: number;
  /** Argon2 parallelism */
  p: number;
  /** Challenge target value (difficulty) */
  d: string;
  /** Expiry time in milliseconds */
  e: number;
  /** IP address of the client */
  ip?: string;
  /** Challenge version */
  v?: number;
  /** Usertoken for refreshing */
  token?: string;
};

const verifySchema = z.object({
  challenge: z.object({
    s: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[0-9a-f]+$/),
    hl: z.number().int().positive().max(64),
    t: z.number().int().positive().min(2).max(10),
    m: z
      .number()
      .int()
      .positive()
      .max(1024 * 1024 * 2),
    p: z.number().int().positive().max(16),
    d: z.string().regex(/^[0-9]+n$/),
    e: z.number().int().positive(),
    ip: z.string().min(1).max(64).optional(),
    v: z.literal(1).optional(),
    token: z.string().min(1).max(64).optional(),
  }),
  solution: z.string().min(1).max(64),
  signature: z.string().min(1),
  proxyKey: z.string().min(1).max(1024).optional(),
});

const challengeSchema = z.object({
  action: z.union([z.literal("new"), z.literal("refresh")]),
  refreshToken: z.string().min(1).max(64).optional(),
  proxyKey: z.string().min(1).max(1024).optional(),
});

/** Solutions by timestamp */
const solves = new Map<string, number>();
/** Recent attempts by IP address */
const recentAttempts = new Map<string, number>();

setInterval(() => {
  const now = Date.now();
  for (const [ip, timestamp] of recentAttempts) {
    if (now - timestamp > LOCKOUT_TIME) {
      recentAttempts.delete(ip);
    }
  }

  for (const [key, timestamp] of solves) {
    if (now - timestamp > POW_EXPIRY) {
      solves.delete(key);
    }
  }
}, 1000);

function generateChallenge(clientIp?: string, token?: string): Challenge {
  let workFactor = workFactors[config.powDifficultyLevel];
  if (token) {
    // Challenge difficulty is reduced for token refreshes
    workFactor = Math.floor(workFactor / 2);
  }
  const hashBits = BigInt(argon2Params.ARGON2_HASH_LENGTH) * 8n;
  const hashMax = 2n ** hashBits;
  const targetValue = hashMax / BigInt(workFactor);

  return {
    s: crypto.randomBytes(32).toString("hex"),
    hl: argon2Params.ARGON2_HASH_LENGTH,
    t: argon2Params.ARGON2_TIME_COST,
    m: argon2Params.ARGON2_MEMORY_KB,
    p: argon2Params.ARGON2_PARALLELISM,
    d: targetValue.toString() + "n",
    e: Date.now() + POW_EXPIRY,
    ip: clientIp,
    token,
  };
}

function signMessage(msg: any): string {
  const hmac = crypto.createHmac("sha256", HMAC_KEY);
  if (typeof msg === "object") {
    hmac.update(JSON.stringify(msg));
  } else {
    hmac.update(msg);
  }
  return hmac.digest("hex");
}

async function verifySolution(
  challenge: Challenge,
  solution: string,
  logger: any
): Promise<boolean> {
  logger.info({ solution, challenge }, "Verifying solution");
  const hash = await argon2.hashRaw(String(solution), {
    salt: Buffer.from(challenge.s, "hex"),
    outputLen: challenge.hl,
    timeCost: challenge.t,
    memoryCost: challenge.m,
    parallelism: challenge.p,
    algorithm: argon2.Algorithm.Argon2id,
  });
  const hashStr = hash.toString("hex");
  const target = BigInt(challenge.d.slice(0, -1));
  const hashValue = BigInt("0x" + hashStr);
  const result = hashValue <= target;
  logger.info({ hashStr, target, hashValue, result }, "Solution verified");
  return result;
}

function verifyTokenRefreshable(token?: string, logger?: any): boolean {
  if (!token) {
    logger?.warn("No token provided for refresh");
    return false;
  }

  const user = getUser(token);
  if (!user) {
    logger?.warn({ token }, "No user found for token");
    return false;
  }
  if (user.type !== "temporary") {
    logger?.warn({ token }, "User is not temporary");
    return false;
  }
  logger?.info(
    { token, refreshable: user.meta?.refreshable },
    "Token refreshable"
  );
  return user.meta?.refreshable;
}

const router = express.Router();
router.post("/challenge", (req, res) => {
  const data = challengeSchema.safeParse(req.body);
  if (!data.success) {
    res
      .status(400)
      .json({ error: "Invalid challenge request", details: data.error });
    return;
  }
  const { action, refreshToken, proxyKey } = data.data;
  if (config.proxyKey && proxyKey !== config.proxyKey) {
    res.status(400).json({ error: "Invalid proxy password" });
    return;
  }

  if (action === "refresh") {
    if (verifyTokenRefreshable(refreshToken, req.log)) {
      res
        .status(400)
        .json({
          error: "Not allowed to refresh that token; request a new one",
        });
      return;
    }
    const challenge = generateChallenge(req.ip, refreshToken);
    const signature = signMessage(challenge);
    res.json({ challenge, signature });
  } else {
    const challenge = generateChallenge(req.ip);
    const signature = signMessage(challenge);
    res.json({ challenge, signature });
  }
});

router.post("/verify", async (req, res) => {
  const ip = req.ip;
  req.log.info("Got verification request");
  if (recentAttempts.has(ip)) {
    res
      .status(429)
      .json({ error: "Rate limited; wait a minute before trying again" });
    return;
  }

  const result = verifySchema.safeParse(req.body);
  if (!result.success) {
    res
      .status(400)
      .json({ error: "Invalid verify request", details: result.error });
    return;
  }

  const { challenge, signature, solution } = result.data;
  if (signMessage(challenge) !== signature) {
    res.status(400).json({
      error:
        "Invalid signature; server may have restarted since challenge was issued. Please request a new challenge.",
    });
    return;
  }

  if (config.proxyKey && result.data.proxyKey !== config.proxyKey) {
    res.status(401).json({ error: "Invalid proxy password" });
    return;
  }

  if (challenge.ip && challenge.ip !== ip) {
    req.log.warn("Attempt to verify from different IP address");
    res.status(400).json({
      error: "Solution must be verified from original IP address",
    });
    return;
  }

  if (solves.has(signature)) {
    req.log.warn("Attempt to reuse signature");
    res.status(400).json({ error: "Reused signature" });
    return;
  }

  if (Date.now() > challenge.e) {
    req.log.warn("Verification took too long");
    res.status(400).json({ error: "Verification took too long" });
    return;
  }

  if (challenge.token && !verifyTokenRefreshable(challenge.token, req.log)) {
    res.status(400).json({ error: "Not allowed to refresh that usertoken" });
    return;
  }

  recentAttempts.set(ip, Date.now());
  try {
    const success = await verifySolution(challenge, solution, req.log);
    if (!success) {
      req.log.warn("Solution failed verification");
      res.status(400).json({ error: "Solution failed verification" });
      return;
    }
    solves.set(signature, Date.now());
  } catch (err) {
    req.log.error(err, "Error verifying proof-of-work");
    res.status(500).json({ error: "Internal error" });
    return;
  }

  if (challenge.token) {
    const user = getUser(challenge.token);
    if (user) {
      user.expiresAt = Date.now() + config.powTokenHours * 60 * 60 * 1000;
      upsertUser(user);
      req.log.info(
        { token: `...${challenge.token.slice(-5)}` },
        "Token refreshed"
      );
      return res.json({ success: true, token: challenge.token });
    }
  } else {
    const token = createUser({
      type: "temporary",
      expiresAt: Date.now() + config.powTokenHours * 60 * 60 * 1000,
    });
    upsertUser({
      token,
      ip: [ip],
      maxIps: config.powTokenMaxIps,
      meta: { refreshable: true },
    });
    req.log.info(
      { ip, token: `...${token.slice(-5)}` },
      "Proof-of-work token issued"
    );
    return res.json({ success: true, token });
  }
});

router.get("/", (_req, res) => {
  res.render("user_request_token", {
    keyRequired: !!config.proxyKey,
    difficultyLevel: config.powDifficultyLevel,
    tokenLifetime: config.powTokenHours,
    tokenMaxIps: config.powTokenMaxIps,
  });
});

export { router as powRouter };
