import crypto from "crypto";
import { Key, KeyProvider } from "..";
import { config } from "../../../config";
import { logger } from "../../../logger";
import { AnthropicModelFamily, getClaudeModelFamily } from "../../models";
import { AnthropicKeyChecker } from "./checker";
import { HttpError, PaymentRequiredError } from "../../errors";

export type AnthropicKeyUpdate = Omit<
  Partial<AnthropicKey>,
  | "key"
  | "hash"
  | "lastUsed"
  | "promptCount"
  | "rateLimitedAt"
  | "rateLimitedUntil"
>;

type AnthropicKeyUsage = {
  [K in AnthropicModelFamily as `${K}Tokens`]: number;
};

export interface AnthropicKey extends Key, AnthropicKeyUsage {
  readonly service: "anthropic";
  readonly modelFamilies: AnthropicModelFamily[];
  /** The time at which this key was last rate limited. */
  rateLimitedAt: number;
  /** The time until which this key is rate limited. */
  rateLimitedUntil: number;
  /**
   * Whether this key requires a special preamble.  For unclear reasons, some
   * Anthropic keys will throw an error if the prompt does not begin with a
   * message from the user, whereas others can be used without a preamble. This
   * is despite using the same API endpoint, version, and model.
   * When a key returns this particular error, we set this flag to true.
   */
  requiresPreamble: boolean;
  /**
   * Whether this key has been detected as being affected by Anthropic's silent
   * 'please answer ethically' prompt poisoning.
   *
   * As of February 2024, they don't seem to use the 'ethically' prompt anymore
   * but now sometimes inject a CYA prefill to discourage the model from
   * outputting copyrighted material, which still interferes with outputs.
   */
  isPozzed: boolean;
  isOverQuota: boolean;
}

/**
 * Upon being rate limited, a key will be locked out for this many milliseconds
 * while we wait for other concurrent requests to finish.
 */
const RATE_LIMIT_LOCKOUT = 2000;
/**
 * Upon assigning a key, we will wait this many milliseconds before allowing it
 * to be used again. This is to prevent the queue from flooding a key with too
 * many requests while we wait to learn whether previous ones succeeded.
 */
const KEY_REUSE_DELAY = 500;

export class AnthropicKeyProvider implements KeyProvider<AnthropicKey> {
  readonly service = "anthropic";

  private keys: AnthropicKey[] = [];
  private checker?: AnthropicKeyChecker;
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
        modelFamilies: ["claude", "claude-opus"],
        isDisabled: false,
        isOverQuota: false,
        isRevoked: false,
        isPozzed: false,
        promptCount: 0,
        lastUsed: 0,
        rateLimitedAt: 0,
        rateLimitedUntil: 0,
        requiresPreamble: false,
        hash: `ant-${crypto
          .createHash("sha256")
          .update(key)
          .digest("hex")
          .slice(0, 8)}`,
        lastChecked: 0,
        claudeTokens: 0,
        "claude-opusTokens": 0,
      };
      this.keys.push(newKey);
    }
    this.log.info({ keyCount: this.keys.length }, "Loaded Anthropic keys.");
  }

  public init() {
    if (config.checkKeys) {
      this.checker = new AnthropicKeyChecker(this.keys, this.update.bind(this));
      this.checker.start();
    }
  }

  public list() {
    return this.keys.map((k) => Object.freeze({ ...k, key: undefined }));
  }

  public get(_model: string) {
    // Currently, all Anthropic keys have access to all models. This will almost
    // certainly change when they move out of beta later this year.
    const availableKeys = this.keys.filter((k) => !k.isDisabled);
    if (availableKeys.length === 0) {
      throw new PaymentRequiredError("No Anthropic keys available.");
    }

    // (largely copied from the OpenAI provider, without trial key support)
    // Select a key, from highest priority to lowest priority:
    // 1. Keys which are not rate limited
    //    a. If all keys were rate limited recently, select the least-recently
    //       rate limited key.
    // 2. Keys which are not pozzed
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

      if (a.isPozzed && !b.isPozzed) return 1;
      if (!a.isPozzed && b.isPozzed) return -1;

      return a.lastUsed - b.lastUsed;
    });

    const selectedKey = keysByPriority[0];
    selectedKey.lastUsed = now;
    this.throttle(selectedKey.hash);
    return { ...selectedKey };
  }

  public disable(key: AnthropicKey) {
    const keyFromPool = this.keys.find((k) => k.hash === key.hash);
    if (!keyFromPool || keyFromPool.isDisabled) return;
    keyFromPool.isDisabled = true;
    this.log.warn({ key: key.hash }, "Key disabled");
  }

  public update(hash: string, update: Partial<AnthropicKey>) {
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
    key[`${getClaudeModelFamily(model)}Tokens`] += tokens;
  }

  public getLockoutPeriod() {
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
    this.keys.forEach((key) => {
      this.update(key.hash, {
        isPozzed: false,
        isOverQuota: false,
        isDisabled: false,
        isRevoked: false,
        lastChecked: 0,
      });
    });
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
