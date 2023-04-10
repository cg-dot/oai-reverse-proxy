import axios, { AxiosError } from "axios";
import { logger } from "../logger";
import type { Key, KeyPool } from "./key-pool";

const MIN_CHECK_INTERVAL = 30 * 1000; // 30 seconds
const KEY_CHECK_PERIOD = 5 * 60 * 1000; // 5 minutes

const GET_MODELS_URL = "https://api.openai.com/v1/models";
const GET_SUBSCRIPTION_URL =
  "https://api.openai.com/dashboard/billing/subscription";
const GET_USAGE_URL = "https://api.openai.com/dashboard/billing/usage";

type GetModelsResponse = {
  data: [{ id: string }];
};

type GetSubscriptionResponse = {
  plan: { title: string };
  has_payment_method: boolean;
  soft_limit_usd: number;
  hard_limit_usd: number;
  system_hard_limit_usd: number;
};

type GetUsageResponse = {
  total_usage: number;
};

export class KeyChecker {
  private readonly keys: Key[];
  private log = logger.child({ module: "KeyChecker" });
  private timeout?: NodeJS.Timeout;
  private updateKey: typeof KeyPool.prototype.update;
  private lastCheck = 0;

  constructor(keys: Key[], updateKey: typeof KeyPool.prototype.update) {
    this.keys = keys;
    this.updateKey = updateKey;
  }

  public start() {
    this.log.info("Starting key checker");
    this.scheduleNextCheck();
  }

  public stop() {
    if (this.timeout) {
      clearTimeout(this.timeout);
    }
  }

  /**
   * Schedules the next check. If there are still keys yet to be checked, it
   * will schedule a check immediately for the next unchecked key. Otherwise,
   * it will schedule a check in several minutes for the oldest key.
   **/
  private scheduleNextCheck() {
    const enabledKeys = this.keys.filter((key) => !key.isDisabled);

    if (enabledKeys.length === 0) {
      this.log.warn("All keys are disabled. Key checker stopping.");
      return;
    }

    // Perform startup checks for any keys that haven't been checked yet.
    const uncheckedKeys = enabledKeys.filter((key) => !key.lastChecked);
    if (uncheckedKeys.length > 0) {
      this.log.info(
        { key: uncheckedKeys[0].hash, remaining: uncheckedKeys.length - 1 },
        "Scheduling initial check for key."
      );
      this.timeout = setTimeout(() => this.checkKey(uncheckedKeys[0]), 1000);
      return;
    }

    // Don't check any individual key more than once every 5 minutes.
    // Also, don't check anything more often than once every 30 seconds.
    const nextCheck = Math.max(
      this.lastCheck + KEY_CHECK_PERIOD,
      Date.now() + MIN_CHECK_INTERVAL
    );

    // Schedule the next check for the oldest key.
    const oldestKey = enabledKeys.reduce((oldest, key) =>
      key.lastChecked < oldest.lastChecked ? key : oldest
    );

    const delay = nextCheck - Date.now();
    this.timeout = setTimeout(() => this.checkKey(oldestKey), delay);
  }

  private async checkKey(key: Key) {
    this.log.info({ key: key.hash }, "Checking key...");
    try {
      const [provisionedModels, subscription, usage] = await Promise.all([
        this.getProvisionedModels(key),
        this.getSubscription(key),
        this.getUsage(key),
      ]);
      const updates = {
        isGpt4: provisionedModels.gpt4,
        isTrial: !subscription.has_payment_method,
        softLimit: subscription.soft_limit_usd,
        hardLimit: subscription.hard_limit_usd,
        systemHardLimit: subscription.system_hard_limit_usd,
        usage,
      };
      this.updateKey(key.hash, updates);
      this.log.info({ key: key.hash, updates }, "Key check complete.");
    } catch (error) {
      // touch the key so we don't check it again for a while
      this.updateKey(key.hash, {});
      this.handleAxiosError(key, error as AxiosError);
    }

    this.lastCheck = Date.now();
    this.scheduleNextCheck();
  }

  private async getProvisionedModels(
    key: Key
  ): Promise<{ turbo: boolean; gpt4: boolean }> {
    const { data } = await axios.get<GetModelsResponse>(GET_MODELS_URL, {
      headers: { Authorization: `Bearer ${key.key}` },
    });
    const turbo = data.data.some(({ id }) => id.startsWith("gpt-3.5"));
    const gpt4 = data.data.some(({ id }) => id.startsWith("gpt-4"));
    return { turbo, gpt4 };
  }

  private async getSubscription(key: Key) {
    const { data } = await axios.get<GetSubscriptionResponse>(
      GET_SUBSCRIPTION_URL,
      { headers: { Authorization: `Bearer ${key.key}` } }
    );
    return data;
  }

  private async getUsage(key: Key) {
    const querystring = KeyChecker.getUsageQuerystring(key.isTrial);
    const url = `${GET_USAGE_URL}?${querystring}`;
    const { data } = await axios.get<GetUsageResponse>(url, {
      headers: { Authorization: `Bearer ${key.key}` },
    });
    return parseFloat((data.total_usage / 100).toFixed(2));
  }

  private handleAxiosError(key: Key, error: AxiosError) {
    if (error.response) {
      const { status, data } = error.response;
      if (status === 401) {
        this.log.warn(
          { key: key.hash, error: data },
          "Key is invalid or revoked. Disabling key."
        );
        this.updateKey(key.hash, { isDisabled: true });
      } else {
        this.log.error(
          { key: key.hash, status, error: data },
          "Encountered API error while checking key."
        );
      }
    } else {
      this.log.error(
        { key: key.hash, error },
        "Network error while checking key."
      );
    }
  }

  static getUsageQuerystring(isTrial: boolean) {
    // For paid keys, the limit resets every month, so we can use the current
    // month as the start date.
    // For trial keys, the limit does not reset, so we need to use the start
    // date of the trial. We don't know that but it can be at most 90 days ago.
    const today = new Date();
    const startDate = isTrial
      ? new Date(today.getTime() - 90 * 24 * 60 * 60 * 1000)
      : new Date(today.getFullYear(), today.getMonth(), 1);
    return `start_date=${startDate.toISOString().split("T")[0]}&end_date=${
      today.toISOString().split("T")[0]
    }`;
  }
}
