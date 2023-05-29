import crypto from "crypto";
import { Key, KeyProvider } from "..";
import { config } from "../../config";
import { logger } from "../../logger";

export const ANTHROPIC_SUPPORTED_MODELS = [
  "claude-instant-v1",
  "claude-instant-v1-100k",
  "claude-v1",
  "claude-v1-100k",
] as const;
export type AnthropicModel = (typeof ANTHROPIC_SUPPORTED_MODELS)[number];

export interface AnthropicKey extends Key {
  readonly service: "anthropic";
  /** The time at which this key was last rate limited. */
  rateLimitedAt: number;
  /** The time until which this key is rate limited. */
  rateLimitedUntil: number;
}

/**
 * We don't get rate limit headers from Anthropic so if we get a 429, we just
 * lock out the key for 10 seconds.
 */
const RATE_LIMIT_LOCKOUT = 10000;

export class AnthropicKeyProvider implements KeyProvider<AnthropicKey> {
  readonly service = "anthropic";

  private keys: AnthropicKey[] = [];
  private log = logger.child({ module: "key-provider", service: this.service });

  constructor() {
    const keyConfig = config.anthropicKey?.trim();
    if (!keyConfig) {
      this.log.warn(
        "ANTHROPIC_KEY is not set. Anthropic API will not be available."
      );
      return;
    }
    let bareKeys: string[];
    bareKeys = [...new Set(keyConfig.split(",").map((k) => k.trim()))];
    for (const key of bareKeys) {
      const newKey: AnthropicKey = {
        key,
        service: this.service,
        isGpt4: false,
        isTrial: false,
        isDisabled: false,
        promptCount: 0,
        lastUsed: 0,
        rateLimitedAt: 0,
        rateLimitedUntil: 0,
        hash: `ant-${crypto
          .createHash("sha256")
          .update(key)
          .digest("hex")
          .slice(0, 8)}`,
        lastChecked: 0,
      };
      this.keys.push(newKey);
    }
    this.log.info({ keyCount: this.keys.length }, "Loaded Anthropic keys.");
  }

  public init() {
    // Nothing to do as Anthropic's API doesn't provide any usage information so
    // there is no key checker implementation and no need to start it.
  }

  public list() {
    return this.keys.map((k) => Object.freeze({ ...k, key: undefined }));
  }

  public get(_model: AnthropicModel) {
    // Currently, all Anthropic keys have access to all models. This will almost
    // certainly change when they move out of beta later this year.
    const availableKeys = this.keys.filter((k) => !k.isDisabled);
    if (availableKeys.length === 0) {
      throw new Error("No Anthropic keys available.");
    }

    // (largely copied from the OpenAI provider, without trial key support)
    // Select a key, from highest priority to lowest priority:
    // 1. Keys which are not rate limited
    //    a. If all keys were rate limited recently, select the least-recently
    //       rate limited key.
    // 2. Keys which have not been used in the longest time

    const now = Date.now();

    const keysByPriority = availableKeys.sort((a, b) => {
      const aRateLimited = now - a.rateLimitedAt < RATE_LIMIT_LOCKOUT;
      const bRateLimited = now - b.rateLimitedAt < RATE_LIMIT_LOCKOUT;

      if (aRateLimited && !bRateLimited) return 1;
      if (!aRateLimited && bRateLimited) return -1;
      if (aRateLimited && bRateLimited) {
        return a.rateLimitedAt - b.rateLimitedAt;
      }
      return a.lastUsed - b.lastUsed;
    });

    const selectedKey = keysByPriority[0];
    selectedKey.lastUsed = now;
    selectedKey.rateLimitedAt = now;
    // Intended to throttle the queue processor as otherwise it will just
    // flood the API with requests and we want to wait a sec to see if we're
    // going to get a rate limit error on this key.
    selectedKey.rateLimitedUntil = now + 1000;
    return { ...selectedKey };
  }

  public disable(key: AnthropicKey) {
    const keyFromPool = this.keys.find((k) => k.key === key.key);
    if (!keyFromPool || keyFromPool.isDisabled) return;
    keyFromPool.isDisabled = true;
    this.log.warn({ key: key.hash }, "Key disabled");
  }

  public available() {
    return this.keys.filter((k) => !k.isDisabled).length;
  }

  // No key checker for Anthropic
  public anyUnchecked() {
    return false;
  }

  public incrementPrompt(hash?: string) {
    const key = this.keys.find((k) => k.hash === hash);
    if (!key) return;
    key.promptCount++;
  }

  public getLockoutPeriod(_model: AnthropicModel) {
    const activeKeys = this.keys.filter((k) => !k.isDisabled);
    // Don't lock out if there are no keys available or the queue will stall.
    // Just let it through so the add-key middleware can throw an error.
    if (activeKeys.length === 0) return 0;

    const now = Date.now();
    const rateLimitedKeys = activeKeys.filter((k) => now < k.rateLimitedUntil);
    const anyNotRateLimited = rateLimitedKeys.length < activeKeys.length;

    if (anyNotRateLimited) return 0;

    // If all keys are rate-limited, return the time until the first key is
    // ready.
    const timeUntilFirstReady = Math.min(
      ...activeKeys.map((k) => k.rateLimitedUntil - now)
    );
    return timeUntilFirstReady;
  }

  /**
   * This is called when we receive a 429, which means there are already five
   * concurrent requests running on this key. We don't have any information on
   * when these requests will resolve so all we can do is wait a bit and try
   * again.
   * We will lock the key for 10 seconds, which should let a few of the other
   * generations finish. This is an arbitrary number but the goal is to balance
   * between not hammering the API with requests and not locking out a key that
   * is actually available.
   * TODO; Try to assign requests to slots on each key so we have an idea of how
   * long each slot has been running and can make a more informed decision on
   * how long to lock the key.
   */
  public markRateLimited(keyHash: string) {
    this.log.warn({ key: keyHash }, "Key rate limited");
    const key = this.keys.find((k) => k.hash === keyHash)!;
    const now = Date.now();
    key.rateLimitedAt = now;
    key.rateLimitedUntil = now + RATE_LIMIT_LOCKOUT;
  }

  public remainingQuota() {
    const activeKeys = this.keys.filter((k) => !k.isDisabled).length;
    const allKeys = this.keys.length;
    if (activeKeys === 0) return 0;
    return Math.round((activeKeys / allKeys) * 100) / 100;
  }

  public usageInUsd() {
    return "$0.00 / ∞";
  }
}
