/**
 * Basic user management. Handles creation and tracking of proxy users, personal
 * access tokens, and quota management. Supports in-memory and Firebase Realtime
 * Database persistence stores.
 *
 * Users are identified solely by their personal access token. The token is
 * used to authenticate the user for all proxied requests.
 */

import admin from "firebase-admin";
import schedule from "node-schedule";
import { v4 as uuid } from "uuid";
import { config, getFirebaseApp } from "../../config";
import { logger } from "../../logger";

const log = logger.child({ module: "users" });

// TODO: Consolidate model families with QueuePartition and KeyProvider.
type QuotaModel = "claude" | "turbo" | "gpt4";

export interface User {
  /** The user's personal access token. */
  token: string;
  /** The user's nickname. */
  nickname?: string;
  /** The IP addresses the user has connected from. */
  ip: string[];
  /** The user's privilege level. */
  type: UserType;
  /** The number of prompts the user has made. */
  promptCount: number;
  /** @deprecated Use `tokenCounts` instead. */
  tokenCount?: never;
  /** The number of tokens the user has consumed, by model family. */
  tokenCounts: Record<QuotaModel, number>;
  /** The maximum number of tokens the user can consume, by model family. */
  tokenLimits: Record<QuotaModel, number>;
  /** The time at which the user was created. */
  createdAt: number;
  /** The time at which the user last connected. */
  lastUsedAt?: number;
  /** The time at which the user was disabled, if applicable. */
  disabledAt?: number;
  /** The reason for which the user was disabled, if applicable. */
  disabledReason?: string;
}

/**
 * Possible privilege levels for a user.
 * - `normal`: Default role. Subject to usual rate limits and quotas.
 * - `special`: Special role. Higher quotas and exempt from auto-ban/lockout.
 */
export type UserType = "normal" | "special";

type UserUpdate = Partial<User> & Pick<User, "token">;

const MAX_IPS_PER_USER = config.maxIpsPerUser;

const users: Map<string, User> = new Map();
const usersToFlush = new Set<string>();

export async function init() {
  log.info({ store: config.gatekeeperStore }, "Initializing user store...");
  if (config.gatekeeperStore === "firebase_rtdb") {
    await initFirebase();
  }
  if (config.quotaRefreshPeriod) {
    const quotaRefreshJob = schedule.scheduleJob(getRefreshCrontab(), () => {
      for (const user of users.values()) {
        refreshQuota(user.token);
      }
      log.info(
        { users: users.size, nextRefresh: quotaRefreshJob.nextInvocation() },
        "Token quotas refreshed."
      );
    });

    if (!quotaRefreshJob) {
      throw new Error(
        "Unable to schedule quota refresh. Is QUOTA_REFRESH_PERIOD set correctly?"
      );
    }
    log.debug(
      { nextRefresh: quotaRefreshJob.nextInvocation() },
      "Scheduled token quota refresh."
    );
  }
  log.info("User store initialized.");
}

/** Creates a new user and returns their token. */
export function createUser() {
  const token = uuid();
  users.set(token, {
    token,
    ip: [],
    type: "normal",
    promptCount: 0,
    tokenCounts: { turbo: 0, gpt4: 0, claude: 0 },
    tokenLimits: { ...config.tokenQuota },
    createdAt: Date.now(),
  });
  usersToFlush.add(token);
  return token;
}

/** Returns the user with the given token if they exist. */
export function getUser(token: string) {
  return users.get(token);
}

/** Returns a list of all users. */
export function getUsers() {
  return Array.from(users.values()).map((user) => ({ ...user }));
}

/**
 * Upserts the given user. Intended for use with the /admin API for updating
 * user information via JSON. Use other functions for more specific operations.
 */
export function upsertUser(user: UserUpdate) {
  // TODO: May need better merging for nested objects
  const existing: User = users.get(user.token) ?? {
    token: user.token,
    ip: [],
    type: "normal",
    promptCount: 0,
    tokenCounts: { turbo: 0, gpt4: 0, claude: 0 },
    tokenLimits: { ...config.tokenQuota },
    createdAt: Date.now(),
  };

  users.set(user.token, {
    ...existing,
    ...user,
  });
  usersToFlush.add(user.token);

  // Immediately schedule a flush to the database if we're using Firebase.
  if (config.gatekeeperStore === "firebase_rtdb") {
    setImmediate(flushUsers);
  }

  return users.get(user.token);
}

/** Increments the prompt count for the given user. */
export function incrementPromptCount(token: string) {
  const user = users.get(token);
  if (!user) return;
  user.promptCount++;
  usersToFlush.add(token);
}

/** Increments token consumption for the given user and model. */
export function incrementTokenCount(
  token: string,
  model: string,
  consumption: number
) {
  const user = users.get(token);
  if (!user) return;
  const modelFamily = getModelFamily(model);
  user.tokenCounts[modelFamily] += consumption;
  usersToFlush.add(token);
}

/**
 * Given a user's token and IP address, authenticates the user and adds the IP
 * to the user's list of IPs. Returns the user if they exist and are not
 * disabled, otherwise returns undefined.
 */
export function authenticate(token: string, ip: string) {
  const user = users.get(token);
  if (!user || user.disabledAt) return;
  if (!user.ip.includes(ip)) user.ip.push(ip);

  // If too many IPs are associated with the user, disable the account.
  const ipLimit =
    user.type === "special" || !MAX_IPS_PER_USER ? Infinity : MAX_IPS_PER_USER;
  if (user.ip.length > ipLimit) {
    disableUser(token, "Too many IP addresses associated with this token.");
    return;
  }

  user.lastUsedAt = Date.now();
  usersToFlush.add(token);
  return user;
}

export function hasAvailableQuota(
  token: string,
  model: string,
  requested: number
) {
  const user = users.get(token);
  if (!user) return false;
  if (user.type === "special") return true;

  const modelFamily = getModelFamily(model);
  const { tokenCounts, tokenLimits } = user;
  const tokenLimit = tokenLimits[modelFamily];

  if (!tokenLimit) return true;

  const tokensConsumed = tokenCounts[modelFamily] + requested;
  return tokensConsumed < tokenLimit;
}

export function refreshQuota(token: string) {
  const user = users.get(token);
  if (!user) return;
  const { tokenCounts, tokenLimits } = user;
  const quotas = Object.entries(config.tokenQuota) as [QuotaModel, number][];
  quotas
    // If a quota is not configured, don't touch any existing limits a user may
    // already have been assigned manually.
    .filter(([, quota]) => quota > 0)
    .forEach(
      ([model, quota]) => (tokenLimits[model] = tokenCounts[model] + quota)
    );
  usersToFlush.add(token);
}

/** Disables the given user, optionally providing a reason. */
export function disableUser(token: string, reason?: string) {
  const user = users.get(token);
  if (!user) return;
  user.disabledAt = Date.now();
  user.disabledReason = reason;
  usersToFlush.add(token);
}

// TODO: Firebase persistence is pretend right now and just polls the in-memory
// store to sync it with Firebase when it changes. Will refactor to abstract
// persistence layer later so we can support multiple stores.
let firebaseTimeout: NodeJS.Timeout | undefined;

async function initFirebase() {
  log.info("Connecting to Firebase...");
  const app = getFirebaseApp();
  const db = admin.database(app);
  const usersRef = db.ref("users");
  const snapshot = await usersRef.once("value");
  const users: Record<string, User> | null = snapshot.val();
  firebaseTimeout = setInterval(flushUsers, 20 * 1000);
  if (!users) {
    log.info("No users found in Firebase.");
    return;
  }
  for (const token in users) {
    upsertUser(users[token]);
  }
  usersToFlush.clear();
  const numUsers = Object.keys(users).length;
  log.info({ users: numUsers }, "Loaded users from Firebase");
}

async function flushUsers() {
  const app = getFirebaseApp();
  const db = admin.database(app);
  const usersRef = db.ref("users");
  const updates: Record<string, User> = {};

  for (const token of usersToFlush) {
    const user = users.get(token);
    if (!user) {
      continue;
    }
    updates[token] = user;
  }

  usersToFlush.clear();

  const numUpdates = Object.keys(updates).length;
  if (numUpdates === 0) {
    return;
  }

  await usersRef.update(updates);
  log.info({ users: Object.keys(updates).length }, "Flushed users to Firebase");
}

function getModelFamily(model: string): QuotaModel {
  if (model.startsWith("gpt-4")) {
    // TODO: add 32k models
    return "gpt4";
  }
  if (model.startsWith("gpt-3.5")) {
    return "turbo";
  }
  return "claude";
}

function getRefreshCrontab() {
  switch (config.quotaRefreshPeriod!) {
    case "hourly":
      return "0 * * * *";
    case "daily":
      return "0 0 * * *";
    default:
      return config.quotaRefreshPeriod ?? "0 0 * * *";
  }
}
