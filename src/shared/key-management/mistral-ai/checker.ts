import axios, { AxiosError } from "axios";
import type { MistralAIModelFamily } from "../../models";
import { KeyCheckerBase } from "../key-checker-base";
import type { MistralAIKey, MistralAIKeyProvider } from "./provider";
import { getMistralAIModelFamily } from "../../models";

const MIN_CHECK_INTERVAL = 3 * 1000; // 3 seconds
const KEY_CHECK_PERIOD = 60 * 60 * 1000; // 1 hour
const GET_MODELS_URL = "https://api.mistral.ai/v1/models";

type GetModelsResponse = {
  data: [{ id: string }];
};

type MistralAIError = {
  message: string;
  request_id: string;
};

type UpdateFn = typeof MistralAIKeyProvider.prototype.update;

export class MistralAIKeyChecker extends KeyCheckerBase<MistralAIKey> {
  constructor(keys: MistralAIKey[], updateKey: UpdateFn) {
    super(keys, {
      service: "mistral-ai",
      keyCheckPeriod: KEY_CHECK_PERIOD,
      minCheckInterval: MIN_CHECK_INTERVAL,
      recurringChecksEnabled: false,
      updateKey,
    });
  }

  protected async testKeyOrFail(key: MistralAIKey) {
    // We only need to check for provisioned models on the initial check.
    const isInitialCheck = !key.lastChecked;
    if (isInitialCheck) {
      const provisionedModels = await this.getProvisionedModels(key);
      const updates = {
        modelFamilies: provisionedModels,
      };
      this.updateKey(key.hash, updates);
    }
    this.log.info({ key: key.hash, models: key.modelFamilies }, "Checked key.");
  }

  private async getProvisionedModels(
    key: MistralAIKey
  ): Promise<MistralAIModelFamily[]> {
    const opts = { headers: MistralAIKeyChecker.getHeaders(key) };
    const { data } = await axios.get<GetModelsResponse>(GET_MODELS_URL, opts);
    const models = data.data;

    const families = new Set<MistralAIModelFamily>();
    models.forEach(({ id }) => families.add(getMistralAIModelFamily(id)));

    // We want to update the key's model families here, but we don't want to
    // update its `lastChecked` timestamp because we need to let the liveness
    // check run before we can consider the key checked.

    const familiesArray = [...families];
    const keyFromPool = this.keys.find((k) => k.hash === key.hash)!;
    this.updateKey(key.hash, {
      modelFamilies: familiesArray,
      lastChecked: keyFromPool.lastChecked,
    });
    return familiesArray;
  }

  protected handleAxiosError(key: MistralAIKey, error: AxiosError) {
    if (error.response && MistralAIKeyChecker.errorIsMistralAIError(error)) {
      const { status, data } = error.response;
      if (status === 401) {
        this.log.warn(
          { key: key.hash, error: data },
          "Key is invalid or revoked. Disabling key."
        );
        this.updateKey(key.hash, {
          isDisabled: true,
          isRevoked: true,
          modelFamilies: ["mistral-tiny"],
        });
      } else {
        this.log.error(
          { key: key.hash, status, error: data },
          "Encountered unexpected error status while checking key. This may indicate a change in the API; please report this."
        );
        this.updateKey(key.hash, { lastChecked: Date.now() });
      }
      return;
    }
    this.log.error(
      { key: key.hash, error: error.message },
      "Network error while checking key; trying this key again in a minute."
    );
    const oneMinute = 60 * 1000;
    const next = Date.now() - (KEY_CHECK_PERIOD - oneMinute);
    this.updateKey(key.hash, { lastChecked: next });
  }

  static errorIsMistralAIError(
    error: AxiosError
  ): error is AxiosError<MistralAIError> {
    const data = error.response?.data as any;
    return data?.message && data?.request_id;
  }

  static getHeaders(key: MistralAIKey) {
    return {
      Authorization: `Bearer ${key.key}`,
    };
  }
}
