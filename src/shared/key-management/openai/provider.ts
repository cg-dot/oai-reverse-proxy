import crypto from "crypto";
import http from "http";
import { Key, KeyProvider } from "../index";
import { config } from "../../../config";
import { logger } from "../../../logger";
import { OpenAIKeyChecker } from "./checker";
import { getOpenAIModelFamily, OpenAIModelFamily } from "../../models";
import { PaymentRequiredError } from "../../errors";

// Flattening model families instead of using a nested object for easier
// cloning.
type OpenAIKeyUsage = {
  [K in OpenAIModelFamily as `${K}Tokens`]: number;
};

export interface OpenAIKey extends Key, OpenAIKeyUsage {
  readonly service: "openai";
  modelFamilies: OpenAIModelFamily[];
  /**
   * Some keys are assigned to multiple organizations, each with their own quota
   * limits. We clone the key for each organization and track usage/disabled
   * status separately.
   */
  organizationId?: string;
  /** Whether this is a free trial key. These are prioritized over paid keys if they can fulfill the request. */
  isTrial: boolean;
  /** Set when key check returns a non-transient 429. */
  isOverQuota: boolean;
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
  /**
   * This key's maximum request rate for GPT-4, per minute.
   */
  gpt4Rpm: number;
  /**
   * Model snapshots available.
   */
  modelSnapshots: string[];
}

export type OpenAIKeyUpdate = Omit<
  Partial<OpenAIKey>,
  "key" | "hash" | "promptCount"
>;

/**
 * Upon assigning a key, we will wait this many milliseconds before allowing it
 * to be used again. This is to prevent the queue from flooding a key with too
 * many requests while we wait to learn whether previous ones succeeded.
 */
const KEY_REUSE_DELAY = 1000;

export class OpenAIKeyProvider implements KeyProvider<OpenAIKey> {
  readonly service = "openai" as const;

  private keys: OpenAIKey[] = [];
  private checker?: OpenAIKeyChecker;
  private log = logger.child({ module: "key-provider", service: this.service });

  constructor() {
    const keyString = config.openaiKey?.trim();
    if (!keyString) {
      this.log.warn("OPENAI_KEY is not set. OpenAI API will not be available.");
      return;
    }
    let bareKeys: string[];
    bareKeys = keyString.split(",").map((k) => k.trim());
    bareKeys = [...new Set(bareKeys)];
    for (const k of bareKeys) {
      const newKey: OpenAIKey = {
        key: k,
        service: "openai" as const,
        modelFamilies: [
          "turbo" as const,
          "gpt4" as const,
          "gpt4-turbo" as const,
        ],
        isTrial: false,
        isDisabled: false,
        isRevoked: false,
        isOverQuota: false,
        lastUsed: 0,
        lastChecked: 0,
        promptCount: 0,
        hash: `oai-${crypto
          .createHash("sha256")
          .update(k)
          .digest("hex")
          .slice(0, 8)}`,
        rateLimitedAt: 0,
        rateLimitRequestsReset: 0,
        rateLimitTokensReset: 0,
        turboTokens: 0,
        gpt4Tokens: 0,
        "gpt4-32kTokens": 0,
        "gpt4-turboTokens": 0,
        "dall-eTokens": 0,
        gpt4Rpm: 0,
        modelSnapshots: [],
      };
      this.keys.push(newKey);
    }
    this.log.info({ keyCount: this.keys.length }, "Loaded OpenAI keys.");
  }

  public init() {
    if (config.checkKeys) {
      const cloneFn = this.clone.bind(this);
      const updateFn = this.update.bind(this);
      this.checker = new OpenAIKeyChecker(this.keys, cloneFn, updateFn);
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

  public get(requestModel: string) {
    let model = requestModel;

    // Special case for GPT-4-32k. Some keys have access to only gpt4-32k-0314
    // but not gpt-4-32k-0613, or its alias gpt-4-32k. Because we add a model
    // family if a key has any snapshot, we need to dealias gpt-4-32k here so
    // we can look for the specific snapshot.
    // gpt-4-32k is superceded by gpt4-turbo so this shouldn't ever change.
    if (model === "gpt-4-32k") model = "gpt-4-32k-0613";

    const neededFamily = getOpenAIModelFamily(model);
    const excludeTrials = model === "text-embedding-ada-002";
    const needsSnapshot = model.match(/-\d{4}(-preview)?$/);

    const availableKeys = this.keys.filter(
      // Allow keys which
      (key) =>
        !key.isDisabled && // are not disabled
        key.modelFamilies.includes(neededFamily) && // have access to the model family we need
        (!excludeTrials || !key.isTrial) && // and are not trials if we don't want them
        (!needsSnapshot || key.modelSnapshots.includes(model)) // and have the specific snapshot we need
    );

    if (availableKeys.length === 0) {
      throw new PaymentRequiredError(
        `No keys can fulfill request for ${model}`
      );
    }

    // Select a key, from highest priority to lowest priority:
    // 1. Keys which are not rate limited
    //    a. We ignore rate limits from >30 seconds ago
    //    b. If all keys were rate limited in the last minute, select the
    //       least recently rate limited key
    // 2. Keys which are trials
    // 3. Keys which do *not* have access to GPT-4-32k
    // 4. Keys which have not been used in the longest time

    const now = Date.now();
    const rateLimitThreshold = 30 * 1000;

    const keysByPriority = availableKeys.sort((a, b) => {
      // TODO: this isn't quite right; keys are briefly artificially rate-
      // limited when they are selected, so this will deprioritize keys that
      // may not actually be limited, simply because they were used recently.
      // This should be adjusted to use a new `rateLimitedUntil` field instead
      // of `rateLimitedAt`.
      const aRateLimited = now - a.rateLimitedAt < rateLimitThreshold;
      const bRateLimited = now - b.rateLimitedAt < rateLimitThreshold;

      if (aRateLimited && !bRateLimited) return 1;
      if (!aRateLimited && bRateLimited) return -1;
      if (aRateLimited && bRateLimited) {
        return a.rateLimitedAt - b.rateLimitedAt;
      }
      // Neither key is rate limited, continue

      if (a.isTrial && !b.isTrial) return -1;
      if (!a.isTrial && b.isTrial) return 1;
      // Neither or both keys are trials, continue

      const aHas32k = a.modelFamilies.includes("gpt4-32k");
      const bHas32k = b.modelFamilies.includes("gpt4-32k");
      if (aHas32k && !bHas32k) return 1;
      if (!aHas32k && bHas32k) return -1;
      // Neither or both keys have 32k, continue

      return a.lastUsed - b.lastUsed;
    });

    const selectedKey = keysByPriority[0];
    selectedKey.lastUsed = now;
    this.throttle(selectedKey.hash);
    return { ...selectedKey };
  }

  /** Called by the key checker to update key information. */
  public update(keyHash: string, update: OpenAIKeyUpdate) {
    const keyFromPool = this.keys.find((k) => k.hash === keyHash)!;
    Object.assign(keyFromPool, { lastChecked: Date.now(), ...update });
  }

  /** Called by the key checker to create clones of keys for the given orgs. */
  public clone(keyHash: string, newOrgIds: string[]) {
    const keyFromPool = this.keys.find((k) => k.hash === keyHash)!;
    const clones = newOrgIds.map((orgId) => {
      const clone: OpenAIKey = {
        ...keyFromPool,
        organizationId: orgId,
        isDisabled: false,
        isRevoked: false,
        isOverQuota: false,
        hash: `oai-${crypto
          .createHash("sha256")
          .update(keyFromPool.key + orgId)
          .digest("hex")
          .slice(0, 8)}`,
        lastChecked: 0, // Force re-check in case the org has different models
      };
      this.log.info(
        { cloneHash: clone.hash, parentHash: keyFromPool.hash, orgId },
        "Cloned organization key"
      );
      return clone;
    });
    this.keys.push(...clones);
  }

  /** Disables a key, or does nothing if the key isn't in this pool. */
  public disable(key: Key) {
    const keyFromPool = this.keys.find((k) => k.hash === key.hash);
    if (!keyFromPool || keyFromPool.isDisabled) return;
    this.update(key.hash, { isDisabled: true });
    this.log.warn({ key: key.hash }, "Key disabled");
  }

  public available() {
    return this.keys.filter((k) => !k.isDisabled).length;
  }

  /**
   * Given a model, returns the period until a key will be available to service
   * the request, or returns 0 if a key is ready immediately.
   */
  public getLockoutPeriod(family: OpenAIModelFamily): number {
    const activeKeys = this.keys.filter(
      (key) => !key.isDisabled && key.modelFamilies.includes(family)
    );

    // Don't lock out if there are no keys available or the queue will stall.
    // Just let it through so the add-key middleware can throw an error.
    if (activeKeys.length === 0) return 0;

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
      return now < key.rateLimitedAt + Math.min(20000, resetTime);
    }).length;
    const anyNotRateLimited = rateLimitedKeys < activeKeys.length;

    if (anyNotRateLimited) {
      return 0;
    }

    // If all keys are rate-limited, return the time until the first key is
    // ready. We don't want to wait longer than 10 seconds because rate limits
    // are a rolling window and keys may become available sooner than the stated
    // reset time.
    return Math.min(
      ...activeKeys.map((key) => {
        const resetTime = Math.max(
          key.rateLimitRequestsReset,
          key.rateLimitTokensReset
        );
        return key.rateLimitedAt + Math.min(20000, resetTime) - now;
      })
    );
  }

  public markRateLimited(keyHash: string) {
    this.log.debug({ key: keyHash }, "Key rate limited");
    const key = this.keys.find((k) => k.hash === keyHash)!;
    key.rateLimitedAt = Date.now();
    // DALL-E requests do not send headers telling us when the rate limit will
    // be reset so we need to set a fallback value here.  Other models will have
    // this overwritten by the `updateRateLimits` method.
    key.rateLimitRequestsReset = 20000;
  }

  public incrementUsage(keyHash: string, model: string, tokens: number) {
    const key = this.keys.find((k) => k.hash === keyHash);
    if (!key) return;
    key.promptCount++;
    key[`${getOpenAIModelFamily(model)}Tokens`] += tokens;
  }

  public updateRateLimits(keyHash: string, headers: http.IncomingHttpHeaders) {
    const key = this.keys.find((k) => k.hash === keyHash)!;
    const requestsReset = headers["x-ratelimit-reset-requests"];
    const tokensReset = headers["x-ratelimit-reset-tokens"];

    if (typeof requestsReset === "string") {
      key.rateLimitRequestsReset = getResetDurationMillis(requestsReset);
    }

    if (typeof tokensReset === "string") {
      key.rateLimitTokensReset = getResetDurationMillis(tokensReset);
    }

    if (!requestsReset && !tokensReset) {
      this.log.warn({ key: key.hash }, `No ratelimit headers; skipping update`);
      return;
    }
  }

  public recheck() {
    this.keys.forEach((key) => {
      this.update(key.hash, {
        isRevoked: false,
        isOverQuota: false,
        isDisabled: false,
        lastChecked: 0,
      });
    });
    this.checker?.scheduleNextCheck();
  }

  /**
   * Called when a key is selected for a request, briefly disabling it to
   * avoid spamming the API with requests while we wait to learn whether this
   * key is already rate limited.
   */
  private throttle(hash: string) {
    const now = Date.now();
    const key = this.keys.find((k) => k.hash === hash)!;

    const currentRateLimit =
      Math.max(key.rateLimitRequestsReset, key.rateLimitTokensReset) +
      key.rateLimitedAt;
    const nextRateLimit = now + KEY_REUSE_DELAY;

    // Don't throttle if the key is already naturally rate limited.
    if (currentRateLimit > nextRateLimit) return;

    key.rateLimitedAt = Date.now();
    key.rateLimitRequestsReset = KEY_REUSE_DELAY;
  }
}

// wip
function calculateRequestsPerMinute(headers: http.IncomingHttpHeaders) {
  const requestsLimit = headers["x-ratelimit-limit-requests"];
  const requestsReset = headers["x-ratelimit-reset-requests"];

  if (typeof requestsLimit !== "string" || typeof requestsReset !== "string") {
    return 0;
  }

  const limit = parseInt(requestsLimit, 10);
  const reset = getResetDurationMillis(requestsReset);

  // If `reset` is less than one minute, OpenAI specifies the `limit` as an
  // integer representing requests per minute.  Otherwise it actually means the
  // requests per day.
  const isPerMinute = reset < 60000;
  if (isPerMinute) return limit;
  return limit / 1440;
}

/**
 * Converts reset string ("14m25s", "21.0032s", "14ms" or "21ms") to a number of
 * milliseconds.
 **/
function getResetDurationMillis(resetDuration?: string): number {
  const match = resetDuration?.match(
    /(?:(\d+)m(?!s))?(?:(\d+(?:\.\d+)?)s)?(?:(\d+)ms)?/
  );

  if (match) {
    const [, minutes, seconds, milliseconds] = match.map(Number);

    const minutesToMillis = (minutes || 0) * 60 * 1000;
    const secondsToMillis = (seconds || 0) * 1000;
    const millisecondsValue = milliseconds || 0;

    return minutesToMillis + secondsToMillis + millisecondsValue;
  }

  return 0;
}
