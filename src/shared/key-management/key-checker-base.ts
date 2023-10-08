import pino from "pino";
import { logger } from "../../logger";
import { Key } from "./index";
import { AxiosError } from "axios";

type KeyCheckerOptions = {
  service: string;
  keyCheckPeriod: number;
  minCheckInterval: number;
}

export abstract class KeyCheckerBase<TKey extends Key> {
  protected readonly service: string;
  /** Minimum time in between any two key checks. */
  protected readonly MIN_CHECK_INTERVAL: number;
  /**
   * Minimum time in between checks for a given key. Because we can no longer
   * read quota usage, there is little reason to check a single key more often
   * than this.
   */
  protected readonly KEY_CHECK_PERIOD: number;
  protected readonly keys: TKey[] = [];
  protected log: pino.Logger;
  protected timeout?: NodeJS.Timeout;
  protected lastCheck = 0;

  protected constructor(keys: TKey[], opts: KeyCheckerOptions) {
    const { service, keyCheckPeriod, minCheckInterval } = opts;
    this.keys = keys;
    this.KEY_CHECK_PERIOD = keyCheckPeriod;
    this.MIN_CHECK_INTERVAL = minCheckInterval;
    this.service = service;
    this.log = logger.child({ module: "key-checker", service });
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
    const callId = Math.random().toString(36).slice(2, 8);
    const timeoutId = this.timeout?.[Symbol.toPrimitive]?.();
    const checkLog = this.log.child({ callId, timeoutId });

    const enabledKeys = this.keys.filter((key) => !key.isDisabled);
    checkLog.debug({ enabled: enabledKeys.length }, "Scheduling next check...");

    clearTimeout(this.timeout);

    if (enabledKeys.length === 0) {
      checkLog.warn("All keys are disabled. Key checker stopping.");
      return;
    }

    // Perform startup checks for any keys that haven't been checked yet.
    const uncheckedKeys = enabledKeys.filter((key) => !key.lastChecked);
    checkLog.debug({ unchecked: uncheckedKeys.length }, "# of unchecked keys");
    if (uncheckedKeys.length > 0) {
      const keysToCheck = uncheckedKeys.slice(0, 12);

      this.timeout = setTimeout(async () => {
        try {
          await Promise.all(keysToCheck.map((key) => this.checkKey(key)));
        } catch (error) {
          this.log.error({ error }, "Error checking one or more keys.");
        }
        checkLog.info("Batch complete.");
        this.scheduleNextCheck();
      }, 250);

      checkLog.info(
        {
          batch: keysToCheck.map((k) => k.hash),
          remaining: uncheckedKeys.length - keysToCheck.length,
          newTimeoutId: this.timeout?.[Symbol.toPrimitive]?.(),
        },
        "Scheduled batch check."
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
      oldestKey.lastChecked + this.KEY_CHECK_PERIOD,
      this.lastCheck + this.MIN_CHECK_INTERVAL
    );

    const delay = nextCheck - Date.now();
    this.timeout = setTimeout(() => this.checkKey(oldestKey), delay);
    checkLog.debug(
      { key: oldestKey.hash, nextCheck: new Date(nextCheck), delay },
      "Scheduled single key check."
    );
  }

  protected abstract checkKey(key: TKey): Promise<void>;

  protected abstract handleAxiosError(key: TKey, error: AxiosError): void;
}