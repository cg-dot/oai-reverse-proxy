/**
 * Basic user management. Handles creation and tracking of proxy users, personal
 * access tokens, and quota management. Supports in-memory and Firebase Realtime
 * Database persistence stores.
 *
 * Users are identified solely by their personal access token. The token is
 * used to authenticate the user for all proxied requests.
 */

import admin from "firebase-admin";
import { v4 as uuid } from "uuid";
import { config, getFirebaseApp } from "../../config";
import { logger } from "../../logger";

export interface User {
  /** The user's personal access token. */
  token: string;
  /** The IP addresses the user has connected from. */
  ip: string[];
  /** The user's privilege level. */
  type: UserType;
  /** The number of prompts the user has made. */
  promptCount: number;
  /** The number of tokens the user has consumed. Not yet implemented. */
  tokenCount: number;
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
 * TODO: implement auto-ban/lockout for normal users when they do naughty shit
 */
export type UserType = "normal" | "special";

type UserUpdate = Partial<User> & Pick<User, "token">;

const users: Map<string, User> = new Map();
const usersToFlush = new Set<string>();

export async function init() {
  logger.info({ store: config.gatekeeperStore }, "Initializing user store...");
  if (config.gatekeeperStore === "firebase_rtdb") {
    await initFirebase();
  }
  logger.info("User store initialized.");
}

/** Creates a new user and returns their token. */
export function createUser() {
  const token = uuid();
  users.set(token, {
    token,
    ip: [],
    type: "normal",
    promptCount: 0,
    tokenCount: 0,
    createdAt: Date.now(),
  });
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
  const existing: User = users.get(user.token) ?? {
    token: user.token,
    ip: [],
    type: "normal",
    promptCount: 0,
    tokenCount: 0,
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

/** Increments the token count for the given user by the given amount. */
export function incrementTokenCount(token: string, amount = 1) {
  const user = users.get(token);
  if (!user) return;
  user.tokenCount += amount;
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
  user.lastUsedAt = Date.now();
  usersToFlush.add(token);
  return user;
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
  logger.info("Connecting to Firebase...");
  const app = getFirebaseApp();
  const db = admin.database(app);
  const usersRef = db.ref("users");
  const snapshot = await usersRef.once("value");
  const users: Record<string, User> | null = snapshot.val();
  firebaseTimeout = setInterval(flushUsers, 20 * 1000);
  if (!users) {
    logger.info("No users found in Firebase.");
    return;
  }
  for (const token in users) {
    upsertUser(users[token]);
  }
  usersToFlush.clear();
  const numUsers = Object.keys(users).length;
  logger.info({ users: numUsers }, "Loaded users from Firebase");
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
  logger.info(
    { users: Object.keys(updates).length },
    "Flushed users to Firebase"
  );
}
