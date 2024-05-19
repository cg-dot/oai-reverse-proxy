import pino from "pino";
import { logger } from "../../logger";
import { Key } from "./index";
import { AxiosError } from "axios";

type KeyCheckerOptions<TKey extends Key = Key> = {
  service: string;
  keyCheckPeriod: number;
  minCheckInterval: number;
  recurringChecksEnabled?: boolean;
  updateKey: (hash: string, props: Partial<TKey>) => void;
};

export abstract class KeyCheckerBase<TKey extends Key> {
  protected readonly service: string;
  protected readonly recurringChecksEnabled: boolean;
  /** Minimum time in between any two key checks. */
  protected readonly minCheckInterval: number;
  /**
   * Minimum time in between checks for a given key. Because we can no longer
   * read quota usage, there is little reason to check a single key more often
   * than this.
   */
  protected readonly keyCheckPeriod: number;
  protected readonly updateKey: (hash: string, props: Partial<TKey>) => void;
  protected readonly keys: TKey[] = [];
  protected log: pino.Logger;
  protected timeout?: NodeJS.Timeout;
  protected lastCheck = 0;

  protected constructor(keys: TKey[], opts: KeyCheckerOptions<TKey>) {
    this.keys = keys;
    this.keyCheckPeriod = opts.keyCheckPeriod;
    this.minCheckInterval = opts.minCheckInterval;
    this.recurringChecksEnabled = opts.recurringChecksEnabled ?? true;
    this.updateKey = opts.updateKey;
    this.service = opts.service;
    this.log = logger.child({ module: "key-checker", service: opts.service });
  }

  public start() {
    this.log.info("Starting key checker...");
    this.timeout = setTimeout(() => this.scheduleNextCheck(), 0);
  }

  public stop() {
    if (this.timeout) {
      this.log.debug("Stopping key checker...");
      clearTimeout(this.timeout);
    }
  }

  /**
   * Schedules the next check. If there are still keys yet to be checked, it
   * will schedule a check immediately for the next unchecked key. Otherwise,
   * it will schedule a check for the least recently checked key, respecting
   * the minimum check interval.
   */
  public scheduleNextCheck() {
    // Gives each concurrent check a correlation ID to make logs less confusing.
    const callId = Math.random().toString(36).slice(2, 8);
    const timeoutId = this.timeout?.[Symbol.toPrimitive]?.();
    const checkLog = this.log.child({ callId, timeoutId });

    const enabledKeys = this.keys.filter((key) => !key.isDisabled);
    const uncheckedKeys = enabledKeys.filter((key) => !key.lastChecked);
    const numEnabled = enabledKeys.length;
    const numUnchecked = uncheckedKeys.length;

    clearTimeout(this.timeout);
    this.timeout = undefined;

    if (!numEnabled) {
      checkLog.warn("All keys are disabled. Stopping.");
      return;
    }

    checkLog.debug({ numEnabled, numUnchecked }, "Scheduling next check...");

    if (numUnchecked > 0) {
      const keycheckBatch = uncheckedKeys.slice(0, 12);

      this.timeout = setTimeout(async () => {
        try {
          await Promise.all(keycheckBatch.map((key) => this.checkKey(key)));
        } catch (error) {
          checkLog.error({ error }, "Error checking one or more keys.");
        }
        checkLog.info("Batch complete.");
        this.scheduleNextCheck();
      }, 250);

      checkLog.info(
        {
          batch: keycheckBatch.map((k) => k.hash),
          remaining: uncheckedKeys.length - keycheckBatch.length,
          newTimeoutId: this.timeout?.[Symbol.toPrimitive]?.(),
        },
        "Scheduled batch of initial checks."
      );
      return;
    }

    if (!this.recurringChecksEnabled) {
      checkLog.info(
        "Initial checks complete and recurring checks are disabled for this service. Stopping."
      );
      return;
    }

    // Schedule the next check for the oldest key.
    const oldestKey = enabledKeys.reduce((oldest, key) =>
      key.lastChecked < oldest.lastChecked ? key : oldest
    );

    // Don't check any individual key too often.
    // Don't check anything at all at a rate faster than once per 3 seconds.
    const nextCheck = Math.max(
      oldestKey.lastChecked + this.keyCheckPeriod,
      this.lastCheck + this.minCheckInterval
    );

    const baseDelay = nextCheck - Date.now();
    const jitter = (Math.random() - 0.5) * baseDelay * 0.5;
    const jitteredDelay = Math.max(1000, baseDelay + jitter);

    this.timeout = setTimeout(
      () => this.checkKey(oldestKey).then(() => this.scheduleNextCheck()),
      jitteredDelay
    );
    checkLog.debug(
      { key: oldestKey.hash, nextCheck: new Date(nextCheck), jitteredDelay },
      "Scheduled next recurring check."
    );
  }

  public async checkKey(key: TKey): Promise<void> {
    if (key.isDisabled) {
      this.log.warn({ key: key.hash }, "Skipping check for disabled key.");
      this.scheduleNextCheck();
      return;
    }
    this.log.debug({ key: key.hash }, "Checking key...");

    try {
      await this.testKeyOrFail(key);
    } catch (error) {
      this.updateKey(key.hash, {});
      this.handleAxiosError(key, error as AxiosError);
    }

    this.lastCheck = Date.now();
  }

  protected abstract testKeyOrFail(key: TKey): Promise<void>;

  protected abstract handleAxiosError(key: TKey, error: AxiosError): void;
}
