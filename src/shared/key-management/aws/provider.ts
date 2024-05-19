import crypto from "crypto";
import { Key, KeyProvider } from "..";
import { config } from "../../../config";
import { logger } from "../../../logger";
import { AwsBedrockModelFamily, getAwsBedrockModelFamily } from "../../models";
import { AwsKeyChecker } from "./checker";
import { PaymentRequiredError } from "../../errors";

type AwsBedrockKeyUsage = {
  [K in AwsBedrockModelFamily as `${K}Tokens`]: number;
};

export interface AwsBedrockKey extends Key, AwsBedrockKeyUsage {
  readonly service: "aws";
  readonly modelFamilies: AwsBedrockModelFamily[];
  /** The time at which this key was last rate limited. */
  rateLimitedAt: number;
  /** The time until which this key is rate limited. */
  rateLimitedUntil: number;
  /**
   * The confirmed logging status of this key. This is "unknown" until we
   * receive a response from the AWS API. Keys which are logged, or not
   * confirmed as not being logged, won't be used unless ALLOW_AWS_LOGGING is
   * set.
   */
  awsLoggingStatus: "unknown" | "disabled" | "enabled";
  sonnetEnabled: boolean;
  haikuEnabled: boolean;
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

export class AwsBedrockKeyProvider implements KeyProvider<AwsBedrockKey> {
  readonly service = "aws";

  private keys: AwsBedrockKey[] = [];
  private checker?: AwsKeyChecker;
  private log = logger.child({ module: "key-provider", service: this.service });

  constructor() {
    const keyConfig = config.awsCredentials?.trim();
    if (!keyConfig) {
      this.log.warn(
        "AWS_CREDENTIALS is not set. AWS Bedrock API will not be available."
      );
      return;
    }
    let bareKeys: string[];
    bareKeys = [...new Set(keyConfig.split(",").map((k) => k.trim()))];
    for (const key of bareKeys) {
      const newKey: AwsBedrockKey = {
        key,
        service: this.service,
        modelFamilies: ["aws-claude"],
        isDisabled: false,
        isRevoked: false,
        promptCount: 0,
        lastUsed: 0,
        rateLimitedAt: 0,
        rateLimitedUntil: 0,
        awsLoggingStatus: "unknown",
        hash: `aws-${crypto
          .createHash("sha256")
          .update(key)
          .digest("hex")
          .slice(0, 8)}`,
        lastChecked: 0,
        sonnetEnabled: true,
        haikuEnabled: false,
        ["aws-claudeTokens"]: 0,
        ["aws-claude-opusTokens"]: 0,
      };
      this.keys.push(newKey);
    }
    this.log.info({ keyCount: this.keys.length }, "Loaded AWS Bedrock keys.");
  }

  public init() {
    if (config.checkKeys) {
      this.checker = new AwsKeyChecker(this.keys, this.update.bind(this));
      this.checker.start();
    }
  }

  public list() {
    return this.keys.map((k) => Object.freeze({ ...k, key: undefined }));
  }

  public get(model: string) {
    const availableKeys = this.keys.filter((k) => {
      const isNotLogged = k.awsLoggingStatus !== "enabled";
      const neededFamily = getAwsBedrockModelFamily(model);
      const needsSonnet =
        model.includes("sonnet") && neededFamily === "aws-claude";
      const needsHaiku =
        model.includes("haiku") && neededFamily === "aws-claude";
      return (
        !k.isDisabled &&
        (isNotLogged || config.allowAwsLogging) &&
        (k.sonnetEnabled || !needsSonnet) && // sonnet and haiku are both under aws-claude, while opus is not
        (k.haikuEnabled || !needsHaiku) &&
        k.modelFamilies.includes(neededFamily)
      );
    });
    if (availableKeys.length === 0) {
      throw new PaymentRequiredError(
        `No AWS Bedrock keys available for model ${model}`
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

  public disable(key: AwsBedrockKey) {
    const keyFromPool = this.keys.find((k) => k.hash === key.hash);
    if (!keyFromPool || keyFromPool.isDisabled) return;
    keyFromPool.isDisabled = true;
    this.log.warn({ key: key.hash }, "Key disabled");
  }

  public update(hash: string, update: Partial<AwsBedrockKey>) {
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
    key[`${getAwsBedrockModelFamily(model)}Tokens`] += tokens;
  }

  public getLockoutPeriod() {
    // TODO: same exact behavior for three providers, should be refactored
    const activeKeys = this.keys.filter((k) => !k.isDisabled);
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
