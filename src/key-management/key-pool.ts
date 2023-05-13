/* Manages OpenAI API keys. Tracks usage, disables expired keys, and provides
round-robin access to keys. Keys are stored in the OPENAI_KEY environment
variable as a comma-separated list of keys. */
import crypto from "crypto";
import fs from "fs";
import http from "http";
import path from "path";
import { config } from "../config";
import { logger } from "../logger";
import { KeyChecker } from "./key-checker";

// TODO: Made too many assumptions about OpenAI being the only provider and now
// this doesn't really work for Anthropic. Create a Provider interface and
// implement Pool, Checker, and Models for each provider.

export type Model = OpenAIModel | AnthropicModel;
export type OpenAIModel = "gpt-3.5-turbo" | "gpt-4";
export type AnthropicModel = "claude-v1" | "claude-instant-v1";
export const SUPPORTED_MODELS: readonly Model[] = [
  "gpt-3.5-turbo",
  "gpt-4",
  "claude-v1",
  "claude-instant-v1",
] as const;

export type Key = {
  /** The OpenAI API key itself. */
  key: string;
  /** Whether this is a free trial key. These are prioritized over paid keys if they can fulfill the request. */
  isTrial: boolean;
  /** Whether this key has been provisioned for GPT-4. */
  isGpt4: boolean;
  /** Whether this key is currently disabled. We set this if we get a 429 or 401 response from OpenAI. */
  isDisabled: boolean;
  /** Threshold at which a warning email will be sent by OpenAI. */
  softLimit: number;
  /** Threshold at which the key will be disabled because it has reached the user-defined limit. */
  hardLimit: number;
  /** The maximum quota allocated to this key by OpenAI. */
  systemHardLimit: number;
  /** The current usage of this key. */
  usage: number;
  /** The number of prompts that have been sent with this key. */
  promptCount: number;
  /** The time at which this key was last used. */
  lastUsed: number;
  /** The time at which this key was last checked. */
  lastChecked: number;
  /** Key hash for displaying usage in the dashboard. */
  hash: string;
  /** The time at which this key was last rate limited. */
  rateLimitedAt: number;
  /**
   * Last known X-RateLimit-Requests-Reset header from OpenAI, converted to a
   * number.
   * Formatted as a `\d+(m|s)` string denoting the time until the limit resets.
   * Specifically, it seems to indicate the time until the key's quota will be
   * fully restored; the key may be usable before this time as the limit is a
   * rolling window.
   *
   * Requests which return a 429 do not count against the quota.
   *
   * Requests which fail for other reasons (e.g. 401) count against the quota.
   */
  rateLimitRequestsReset: number;
  /**
   * Last known X-RateLimit-Tokens-Reset header from OpenAI, converted to a
   * number.
   * Appears to follow the same format as `rateLimitRequestsReset`.
   *
   * Requests which fail do not count against the quota as they do not consume
   * tokens.
   */
  rateLimitTokensReset: number;
};

export type KeyUpdate = Omit<
  Partial<Key>,
  "key" | "hash" | "lastUsed" | "lastChecked" | "promptCount"
>;

export class KeyPool {
  private keys: Key[] = [];
  private checker?: KeyChecker;
  private log = logger.child({ module: "key-pool" });

  constructor() {
    const keyString = config.openaiKey;
    if (!keyString?.trim()) {
      throw new Error("OPENAI_KEY environment variable is not set");
    }
    let bareKeys: string[];
    bareKeys = keyString.split(",").map((k) => k.trim());
    bareKeys = [...new Set(bareKeys)];
    for (const k of bareKeys) {
      const newKey = {
        key: k,
        isGpt4: false,
        isTrial: false,
        isDisabled: false,
        softLimit: 0,
        hardLimit: 0,
        systemHardLimit: 0,
        usage: 0,
        lastUsed: 0,
        lastChecked: 0,
        promptCount: 0,
        hash: crypto.createHash("sha256").update(k).digest("hex").slice(0, 8),
        rateLimitedAt: 0,
        rateLimitRequestsReset: 0,
        rateLimitTokensReset: 0,
      };
      this.keys.push(newKey);

    }
    this.log.info({ keyCount: this.keys.length }, "Loaded keys");
  }

  public init() {
    if (config.checkKeys) {
      this.checker = new KeyChecker(this.keys, this.update.bind(this));
      this.checker.start();
    }
  }

  /**
   * Returns a list of all keys, with the key field removed.
   * Don't mutate returned keys, use a KeyPool method instead.
   **/
  public list() {
    return this.keys.map((key) => {
      return Object.freeze({
        ...key,
        key: undefined,
      });
    });
  }

  public get(model: Model) {
    const needGpt4 = model.startsWith("gpt-4");
    const availableKeys = this.keys.filter(
      (key) => !key.isDisabled && (!needGpt4 || key.isGpt4)
    );
    if (availableKeys.length === 0) {
      let message = "No keys available. Please add more keys.";
      if (needGpt4) {
        message =
          "No GPT-4 keys available. Please add more keys or select a non-GPT-4 model.";
      }
      throw new Error(message);
    }

    // Select a key, from highest priority to lowest priority:
    // 1. Keys which are not rate limited
    //    a. We can assume any rate limits over a minute ago are expired
    //    b. If all keys were rate limited in the last minute, select the
    //       least recently rate limited key
    // 2. Keys which are trials
    // 3. Keys which have not been used in the longest time

    const now = Date.now();
    const rateLimitThreshold = 60 * 1000;

    const keysByPriority = availableKeys.sort((a, b) => {
      const aRateLimited = now - a.rateLimitedAt < rateLimitThreshold;
      const bRateLimited = now - b.rateLimitedAt < rateLimitThreshold;

      if (aRateLimited && !bRateLimited) return 1;
      if (!aRateLimited && bRateLimited) return -1;
      if (aRateLimited && bRateLimited) {
        return a.rateLimitedAt - b.rateLimitedAt;
      }

      if (a.isTrial && !b.isTrial) return -1;
      if (!a.isTrial && b.isTrial) return 1;

      return a.lastUsed - b.lastUsed;
    });

    const selectedKey = keysByPriority[0];
    selectedKey.lastUsed = Date.now();

    // When a key is selected, we rate-limit it for a brief period of time to
    // prevent the queue processor from immediately flooding it with requests
    // while the initial request is still being processed (which is when we will
    // get new rate limit headers).
    // Instead, we will let a request through every second until the key
    // becomes fully saturated and locked out again.
    selectedKey.rateLimitedAt = Date.now();
    selectedKey.rateLimitRequestsReset = 1000;
    return { ...selectedKey };
  }

  /** Called by the key checker to update key information. */
  public update(keyHash: string, update: KeyUpdate) {
    const keyFromPool = this.keys.find((k) => k.hash === keyHash)!;
    Object.assign(keyFromPool, { ...update, lastChecked: Date.now() });
    // this.writeKeyStatus();
  }

  public disable(key: Key) {
    const keyFromPool = this.keys.find((k) => k.key === key.key)!;
    if (keyFromPool.isDisabled) return;
    keyFromPool.isDisabled = true;
    // If it's disabled just set the usage to the hard limit so it doesn't
    // mess with the aggregate usage.
    keyFromPool.usage = keyFromPool.hardLimit;
    this.log.warn({ key: key.hash }, "Key disabled");
  }

  public available() {
    return this.keys.filter((k) => !k.isDisabled).length;
  }

  public anyUnchecked() {
    return config.checkKeys && this.keys.some((key) => !key.lastChecked);
  }

  /**
   * Given a model, returns the period until a key will be available to service
   * the request, or returns 0 if a key is ready immediately.
   */
  public getLockoutPeriod(model: Model = "gpt-4"): number {
    const needGpt4 = model.startsWith("gpt-4");
    const activeKeys = this.keys.filter(
      (key) => !key.isDisabled && (!needGpt4 || key.isGpt4)
    );

    if (activeKeys.length === 0) {
      // If there are no active keys for this model we can't fulfill requests.
      // We'll return 0 to let the request through and return an error,
      // otherwise the request will be stuck in the queue forever.
      return 0;
    }

    // A key is rate-limited if its `rateLimitedAt` plus the greater of its
    // `rateLimitRequestsReset` and `rateLimitTokensReset` is after the
    // current time.

    // If there are any keys that are not rate-limited, we can fulfill requests.
    const now = Date.now();
    const rateLimitedKeys = activeKeys.filter((key) => {
      const resetTime = Math.max(
        key.rateLimitRequestsReset,
        key.rateLimitTokensReset
      );
      return now < key.rateLimitedAt + resetTime;
    }).length;
    const anyNotRateLimited = rateLimitedKeys < activeKeys.length;

    if (anyNotRateLimited) {
      return 0;
    }

    // If all keys are rate-limited, return the time until the first key is
    // ready.
    const timeUntilFirstReady = Math.min(
      ...activeKeys.map((key) => {
        const resetTime = Math.max(
          key.rateLimitRequestsReset,
          key.rateLimitTokensReset
        );
        return key.rateLimitedAt + resetTime - now;
      })
    );
    return timeUntilFirstReady;
  }

  public markRateLimited(keyHash: string) {
    this.log.warn({ key: keyHash }, "Key rate limited");
    const key = this.keys.find((k) => k.hash === keyHash)!;
    key.rateLimitedAt = Date.now();
  }

  public incrementPrompt(keyHash?: string) {
    if (!keyHash) return;
    const key = this.keys.find((k) => k.hash === keyHash)!;
    key.promptCount++;
  }

  public updateRateLimits(keyHash: string, headers: http.IncomingHttpHeaders) {
    const key = this.keys.find((k) => k.hash === keyHash)!;
    const requestsReset = headers["x-ratelimit-reset-requests"];
    const tokensReset = headers["x-ratelimit-reset-tokens"];

    // Sometimes OpenAI only sends one of the two rate limit headers, it's
    // unclear why.

    if (requestsReset && typeof requestsReset === "string") {
      this.log.info(
        { key: key.hash, requestsReset },
        `Updating rate limit requests reset time`
      );
      key.rateLimitRequestsReset = getResetDurationMillis(requestsReset);
    }

    if (tokensReset && typeof tokensReset === "string") {
      this.log.info(
        { key: key.hash, tokensReset },
        `Updating rate limit tokens reset time`
      );
      key.rateLimitTokensReset = getResetDurationMillis(tokensReset);
    }

    if (!requestsReset && !tokensReset) {
      this.log.warn(
        { key: key.hash },
        `No rate limit headers in OpenAI response; skipping update`
      );
      return;
    }
  }

  /** Returns the remaining aggregate quota for all keys as a percentage. */
  public remainingQuota(gpt4 = false) {
    const keys = this.keys.filter((k) => k.isGpt4 === gpt4);
    if (keys.length === 0) return 0;

    const totalUsage = keys.reduce((acc, key) => {
      // Keys can slightly exceed their quota
      return acc + Math.min(key.usage, key.hardLimit);
    }, 0);
    const totalLimit = keys.reduce((acc, { hardLimit }) => acc + hardLimit, 0);

    return 1 - totalUsage / totalLimit;
  }

  /** Returns used and available usage in USD. */
  public usageInUsd(gpt4 = false) {
    const keys = this.keys.filter((k) => k.isGpt4 === gpt4);
    if (keys.length === 0) return "???";

    const totalHardLimit = keys.reduce(
      (acc, { hardLimit }) => acc + hardLimit,
      0
    );
    const totalUsage = keys.reduce((acc, key) => {
      // Keys can slightly exceed their quota
      return acc + Math.min(key.usage, key.hardLimit);
    }, 0);

    return `$${totalUsage.toFixed(2)} / $${totalHardLimit.toFixed(2)}`;
  }

  /** Writes key status to disk. */
  // public writeKeyStatus() {
  //   const keys = this.keys.map((key) => ({
  //     key: key.key,
  //     isGpt4: key.isGpt4,
  //     usage: key.usage,
  //     hardLimit: key.hardLimit,
  //     isDisabled: key.isDisabled,
  //   }));
  //   fs.writeFileSync(
  //     path.join(__dirname, "..", "keys.json"),
  //     JSON.stringify(keys, null, 2)
  //   );
  // }
}



/**
 * Converts reset string ("21.0032s" or "21ms") to a number of milliseconds.
 * Result is clamped to 10s even though the API returns up to 60s, because the
 * API returns the time until the entire quota is reset, even if a key may be
 * able to fulfill requests before then due to partial resets.
 **/
function getResetDurationMillis(resetDuration?: string): number {
  const match = resetDuration?.match(/(\d+(\.\d+)?)(s|ms)/);
  if (match) {
    const [, time, , unit] = match;
    const value = parseFloat(time);
    const result = unit === "s" ? value * 1000 : value;
    return Math.min(result, 10000);
  }
  return 0;
}
