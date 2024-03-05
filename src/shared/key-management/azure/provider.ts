import crypto from "crypto";
import { Key, KeyProvider } from "..";
import { config } from "../../../config";
import { logger } from "../../../logger";
import type { AzureOpenAIModelFamily } from "../../models";
import { getAzureOpenAIModelFamily } from "../../models";
import { OpenAIModel } from "../openai/provider";
import { AzureOpenAIKeyChecker } from "./checker";
import { HttpError } from "../../errors";

export type AzureOpenAIModel = Exclude<OpenAIModel, "dall-e">;

type AzureOpenAIKeyUsage = {
  [K in AzureOpenAIModelFamily as `${K}Tokens`]: number;
};

export interface AzureOpenAIKey extends Key, AzureOpenAIKeyUsage {
  readonly service: "azure";
  readonly modelFamilies: AzureOpenAIModelFamily[];
  /** The time at which this key was last rate limited. */
  rateLimitedAt: number;
  /** The time until which this key is rate limited. */
  rateLimitedUntil: number;
  contentFiltering: boolean;
}

/**
 * Upon being rate limited, a key will be locked out for this many milliseconds
 * while we wait for other concurrent requests to finish.
 */
const RATE_LIMIT_LOCKOUT = 4000;
/**
 * Upon assigning a key, we will wait this many milliseconds before allowing it
 * to be used again. This is to prevent the queue from flooding a key with too
 * many requests while we wait to learn whether previous ones succeeded.
 */
const KEY_REUSE_DELAY = 500;

export class AzureOpenAIKeyProvider implements KeyProvider<AzureOpenAIKey> {
  readonly service = "azure";

  private keys: AzureOpenAIKey[] = [];
  private checker?: AzureOpenAIKeyChecker;
  private log = logger.child({ module: "key-provider", service: this.service });

  constructor() {
    const keyConfig = config.azureCredentials;
    if (!keyConfig) {
      this.log.warn(
        "AZURE_CREDENTIALS is not set. Azure OpenAI API will not be available."
      );
      return;
    }
    let bareKeys: string[];
    bareKeys = [...new Set(keyConfig.split(",").map((k) => k.trim()))];
    for (const key of bareKeys) {
      const newKey: AzureOpenAIKey = {
        key,
        service: this.service,
        modelFamilies: ["azure-gpt4"],
        isDisabled: false,
        isRevoked: false,
        promptCount: 0,
        lastUsed: 0,
        rateLimitedAt: 0,
        rateLimitedUntil: 0,
        contentFiltering: false,
        hash: `azu-${crypto
          .createHash("sha256")
          .update(key)
          .digest("hex")
          .slice(0, 8)}`,
        lastChecked: 0,
        "azure-turboTokens": 0,
        "azure-gpt4Tokens": 0,
        "azure-gpt4-32kTokens": 0,
        "azure-gpt4-turboTokens": 0,
      };
      this.keys.push(newKey);
    }
    this.log.info({ keyCount: this.keys.length }, "Loaded Azure OpenAI keys.");
  }

  public init() {
    if (config.checkKeys) {
      this.checker = new AzureOpenAIKeyChecker(
        this.keys,
        this.update.bind(this)
      );
      this.checker.start();
    }
  }

  public list() {
    return this.keys.map((k) => Object.freeze({ ...k, key: undefined }));
  }

  public get(model: AzureOpenAIModel) {
    const neededFamily = getAzureOpenAIModelFamily(model);
    const availableKeys = this.keys.filter(
      (k) => !k.isDisabled && k.modelFamilies.includes(neededFamily)
    );
    if (availableKeys.length === 0) {
      throw new HttpError(
        402,
        `No keys available for model family '${neededFamily}'.`
      );
    }

    // (largely copied from the OpenAI provider, without trial key support)
    // Select a key, from highest priority to lowest priority:
    // 1. Keys which are not rate limited
    //    a. If all keys were rate limited recently, select the least-recently
    //       rate limited key.
    // 3. Keys which have not been used in the longest time

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
    this.throttle(selectedKey.hash);
    return { ...selectedKey };
  }

  public disable(key: AzureOpenAIKey) {
    const keyFromPool = this.keys.find((k) => k.hash === key.hash);
    if (!keyFromPool || keyFromPool.isDisabled) return;
    keyFromPool.isDisabled = true;
    this.log.warn({ key: key.hash }, "Key disabled");
  }

  public update(hash: string, update: Partial<AzureOpenAIKey>) {
    const keyFromPool = this.keys.find((k) => k.hash === hash)!;
    Object.assign(keyFromPool, { lastChecked: Date.now(), ...update });
  }

  public available() {
    return this.keys.filter((k) => !k.isDisabled).length;
  }

  public incrementUsage(hash: string, model: string, tokens: number) {
    const key = this.keys.find((k) => k.hash === hash);
    if (!key) return;
    key.promptCount++;
    key[`${getAzureOpenAIModelFamily(model)}Tokens`] += tokens;
  }

  // TODO: all of this shit is duplicate code

  public getLockoutPeriod(family: AzureOpenAIModelFamily) {
    const activeKeys = this.keys.filter(
      (key) => !key.isDisabled && key.modelFamilies.includes(family)
    );

    // Don't lock out if there are no keys available or the queue will stall.
    // Just let it through so the add-key middleware can throw an error.
    if (activeKeys.length === 0) return 0;

    const now = Date.now();
    const rateLimitedKeys = activeKeys.filter((k) => now < k.rateLimitedUntil);
    const anyNotRateLimited = rateLimitedKeys.length < activeKeys.length;

    if (anyNotRateLimited) return 0;

    // If all keys are rate-limited, return time until the first key is ready.
    return Math.min(...activeKeys.map((k) => k.rateLimitedUntil - now));
  }

  /**
   * This is called when we receive a 429, which means there are already five
   * concurrent requests running on this key. We don't have any information on
   * when these requests will resolve, so all we can do is wait a bit and try
   * again. We will lock the key for 2 seconds after getting a 429 before
   * retrying in order to give the other requests a chance to finish.
   */
  public markRateLimited(keyHash: string) {
    this.log.debug({ key: keyHash }, "Key rate limited");
    const key = this.keys.find((k) => k.hash === keyHash)!;
    const now = Date.now();
    key.rateLimitedAt = now;
    key.rateLimitedUntil = now + RATE_LIMIT_LOCKOUT;
  }

  public recheck() {
    this.keys.forEach(({ hash }) =>
      this.update(hash, { lastChecked: 0, isDisabled: false, isRevoked: false })
    );
    this.checker?.scheduleNextCheck();
  }

  /**
   * Applies a short artificial delay to the key upon dequeueing, in order to
   * prevent it from being immediately assigned to another request before the
   * current one can be dispatched.
   **/
  private throttle(hash: string) {
    const now = Date.now();
    const key = this.keys.find((k) => k.hash === hash)!;

    const currentRateLimit = key.rateLimitedUntil;
    const nextRateLimit = now + KEY_REUSE_DELAY;

    key.rateLimitedAt = now;
    key.rateLimitedUntil = Math.max(currentRateLimit, nextRateLimit);
  }
}
