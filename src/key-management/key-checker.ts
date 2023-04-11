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

type UpdateFn = typeof KeyPool.prototype.update;

export class KeyChecker {
  private readonly keys: Key[];
  private log = logger.child({ module: "KeyChecker" });
  private timeout?: NodeJS.Timeout;
  private updateKey: UpdateFn;
  private lastCheck = 0;

  constructor(keys: Key[], updateKey: UpdateFn) {
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

    // Schedule the next check for the oldest key.
    const oldestKey = enabledKeys.reduce((oldest, key) =>
      key.lastChecked < oldest.lastChecked ? key : oldest
    );

    // Don't check any individual key more than once every 5 minutes.
    // Also, don't check anything more often than once every 30 seconds.
    const nextCheck = Math.max(
      oldestKey.lastChecked + KEY_CHECK_PERIOD,
      this.lastCheck + MIN_CHECK_INTERVAL
    );

    this.log.info(
      { key: oldestKey.hash, nextCheck: new Date(nextCheck) },
      "Scheduling next check."
    );

    const delay = nextCheck - Date.now();
    this.timeout = setTimeout(() => this.checkKey(oldestKey), delay);
  }

  private async checkKey(key: Key) {
    // It's possible this key might have been disabled while we were waiting
    // for the next check.
    if (key.isDisabled) {
      this.log.warn({ key: key.hash }, "Skipping check for disabled key.");
      this.scheduleNextCheck();
      return;
    }

    this.log.info({ key: key.hash }, "Checking key...");
    try {
      // During the initial check we need to get the subscription first because
      // trials have different behavior.
      if (!key.lastChecked) {
        const subscription = await this.getSubscription(key);
        this.updateKey(key.hash, { isTrial: !subscription.has_payment_method });
        const [provisionedModels, usage] = await Promise.all([
          this.getProvisionedModels(key),
          this.getUsage(key),
        ]);
        const updates = {
          isGpt4: provisionedModels.gpt4,
          softLimit: subscription.soft_limit_usd,
          hardLimit: subscription.hard_limit_usd,
          systemHardLimit: subscription.system_hard_limit_usd,
          usage,
        };
        this.updateKey(key.hash, updates);
      } else {
        // Don't check provisioned models after the initial check because it's
        // not likely to change.
        const [subscription, usage] = await Promise.all([
          this.getSubscription(key),
          this.getUsage(key),
        ]);
        const updates = {
          softLimit: subscription.soft_limit_usd,
          hardLimit: subscription.hard_limit_usd,
          systemHardLimit: subscription.system_hard_limit_usd,
          usage,
        };
        this.updateKey(key.hash, updates);
      }
      this.log.info(
        { key: key.hash, usage: key.usage, hardLimit: key.hardLimit },
        "Key check complete."
      );
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

  // TODO: This endpoint seems to be very delayed. I think we will need to track
  // the time it last changed and estimate token usage ourselves in between
  // changes by inspecting request payloads for prompt and completion tokens.
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

  // TODO: Trial key usage reporting is very unreliable and keys with supposedly
  // no usage are already exhausted.  Instead we should try generating some text
  // on the first check to quickly determine if the key is alive.
  private async doTestGeneration(key: Key) {
    // Generate only a single token with a very short prompt to avoid using
    // too much of the key's quota.
    // NYI
  }

  static getUsageQuerystring(isTrial: boolean) {
    // For paid keys, the limit resets every month, so we can use the first day
    // of the current month.
    // For trial keys, the limit does not reset and we don't know when the key
    // was created, so we use 99 days ago because that's as far back as the API
    // will let us go.

    // End date needs to be set to the beginning of the next day so that we get
    // usage for the current day.

    const today = new Date();
    const startDate = isTrial
      ? new Date(today.getTime() - 99 * 24 * 60 * 60 * 1000)
      : new Date(today.getFullYear(), today.getMonth(), 1);
    const endDate = new Date(today.getTime() + 24 * 60 * 60 * 1000);
    return `start_date=${startDate.toISOString().split("T")[0]}&end_date=${
      endDate.toISOString().split("T")[0]
    }`;
  }
}
