/* Manages OpenAI API keys. Tracks usage, disables expired keys, and provides
round-robin access to keys. Keys are stored in the OPENAI_KEY environment
variable, either as a single key, or a base64-encoded JSON array of keys.*/
import crypto from "crypto";
import { config } from "./config";
import { logger } from "./logger";

/** Represents a key stored in the OPENAI_KEY environment variable. */
type KeySchema = {
  /** The OpenAI API key itself. */
  key: string;
  /** Whether this is a free trial key. These are prioritized over paid keys if they can fulfill the request. */
  isTrial?: boolean;
  /** Whether this key has been provisioned for GPT-4. */
  isGpt4?: boolean;
};

/** Runtime information about a key. */
export type Key = KeySchema & {
  /** Whether this key is currently disabled. We set this if we get a 429 or 401 response from OpenAI. */
  isDisabled?: boolean;
  /** Threshold at which a warning email will be sent by OpenAI. */
  softLimit?: number;
  /** Threshold at which the key will be disabled because it has reached the user-defined limit. */
  hardLimit?: number;
  /** The maximum quota allocated to this key by OpenAI. */
  systemHardLimit?: number;
  /** The current usage of this key. */
  usage?: number;
  /** The number of prompts that have been sent with this key. */
  promptCount: number;
  /** The time at which this key was last used. */
  lastUsed: number;
  /** Key hash for displaying usage in the dashboard. */
  hash: string;
};

const keyPool: Key[] = [];

function init() {
  const keyString = config.openaiKey;
  if (!keyString?.trim()) {
    throw new Error("OPENAI_KEY environment variable is not set");
  }
  let keyList: KeySchema[];
  try {
    const decoded = Buffer.from(keyString, "base64").toString();
    keyList = JSON.parse(decoded) as KeySchema[];
  } catch (err) {
    logger.info("OPENAI_KEY is not base64-encoded JSON, assuming bare key");
    // We don't actually know if bare keys are paid/GPT-4 so we assume they are
    keyList = [{ key: keyString, isTrial: false, isGpt4: true }];
  }
  for (const key of keyList) {
    const newKey = {
      ...key,
      isDisabled: false,
      softLimit: 0,
      hardLimit: 0,
      systemHardLimit: 0,
      usage: 0,
      lastUsed: 0,
      promptCount: 0,
      hash: crypto
        .createHash("sha256")
        .update(key.key)
        .digest("hex")
        .slice(0, 6),
    };
    keyPool.push(newKey);

    logger.info({ key: newKey.hash }, "Key added");
  }
  // TODO: check each key's usage upon startup.
}

function list() {
  return keyPool.map((key) => ({
    ...key,
    key: undefined,
  }));
}

function disable(key: Key) {
  const keyFromPool = keyPool.find((k) => k.key === key.key)!;
  if (keyFromPool.isDisabled) return;
  keyFromPool.isDisabled = true;
  logger.warn({ key: key.hash }, "Key disabled");
}

function anyAvailable() {
  return keyPool.some((key) => !key.isDisabled);
}

function get(model: string) {
  const needsGpt4Key = model.startsWith("gpt-4");
  const availableKeys = keyPool.filter(
    (key) => !key.isDisabled && (!needsGpt4Key || key.isGpt4)
  );
  if (availableKeys.length === 0) {
    let message = "No keys available. Please add more keys.";
    if (needsGpt4Key) {
      message =
        "No GPT-4 keys available. Please add more keys or use a non-GPT-4 model.";
    }
    logger.error(message);
    throw new Error(message);
  }

  // Prioritize trial keys
  const trialKeys = availableKeys.filter((key) => key.isTrial);
  if (trialKeys.length > 0) {
    logger.info({ key: trialKeys[0].hash }, "Using trial key");
    trialKeys[0].lastUsed = Date.now();
    return trialKeys[0];
  }

  // Otherwise, return the oldest key
  const oldestKey = availableKeys.sort((a, b) => a.lastUsed - b.lastUsed)[0];
  logger.info({ key: oldestKey.hash }, "Assigning key to request.");
  oldestKey.lastUsed = Date.now();
  return { ...oldestKey };
}

function incrementPrompt(keyHash?: string) {
  if (!keyHash) return;
  const key = keyPool.find((k) => k.hash === keyHash)!;
  key.promptCount++;
}

function downgradeKey(keyHash?: string) {
  if (!keyHash) return;
  logger.warn({ key: keyHash }, "Downgrading key to GPT-3.5.");
  const key = keyPool.find((k) => k.hash === keyHash)!;
  key.isGpt4 = false;
}

export const keys = {
  init,
  list,
  get,
  anyAvailable,
  disable,
  incrementPrompt,
  downgradeKey,
};
