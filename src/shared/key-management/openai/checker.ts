import axios, { AxiosError } from "axios";
import type { OpenAIModelFamily } from "../../models";
import { KeyCheckerBase } from "../key-checker-base";
import type { OpenAIKey, OpenAIKeyProvider } from "./provider";
import { getOpenAIModelFamily } from "../../models";

const MIN_CHECK_INTERVAL = 3 * 1000; // 3 seconds
const KEY_CHECK_PERIOD = 60 * 60 * 1000; // 1 hour
const POST_CHAT_COMPLETIONS_URL = "https://api.openai.com/v1/chat/completions";
const GET_MODELS_URL = "https://api.openai.com/v1/models";
const GET_ORGANIZATIONS_URL = "https://api.openai.com/v1/organizations";

type GetModelsResponse = {
  data: [{ id: string }];
};

type GetOrganizationsResponse = {
  data: [{ id: string; is_default: boolean }];
};

type OpenAIError = {
  error: { type: string; code: string; param: unknown; message: string };
};

type CloneFn = typeof OpenAIKeyProvider.prototype.clone;
type UpdateFn = typeof OpenAIKeyProvider.prototype.update;

export class OpenAIKeyChecker extends KeyCheckerBase<OpenAIKey> {
  private readonly cloneKey: CloneFn;

  constructor(keys: OpenAIKey[], cloneFn: CloneFn, updateKey: UpdateFn) {
    super(keys, {
      service: "openai",
      keyCheckPeriod: KEY_CHECK_PERIOD,
      minCheckInterval: MIN_CHECK_INTERVAL,
      recurringChecksEnabled: false,
      updateKey,
    });
    this.cloneKey = cloneFn;
  }

  protected async testKeyOrFail(key: OpenAIKey) {
    // We only need to check for provisioned models on the initial check.
    const isInitialCheck = !key.lastChecked;
    if (isInitialCheck) {
      const [provisionedModels, livenessTest] = await Promise.all([
        this.getProvisionedModels(key),
        this.testLiveness(key),
        this.maybeCreateOrganizationClones(key),
      ]);
      const updates = {
        modelFamilies: provisionedModels,
        isTrial: livenessTest.rateLimit <= 250,
      };
      this.updateKey(key.hash, updates);
    } else {
      // No updates needed as models and trial status generally don't change.
      const [_livenessTest] = await Promise.all([this.testLiveness(key)]);
      this.updateKey(key.hash, {});
    }
    this.log.info(
      {
        key: key.hash,
        models: key.modelFamilies,
        trial: key.isTrial,
        snapshots: key.modelSnapshots,
      },
      "Checked key."
    );
  }

  private async getProvisionedModels(
    key: OpenAIKey
  ): Promise<OpenAIModelFamily[]> {
    const opts = { headers: OpenAIKeyChecker.getHeaders(key) };
    const { data } = await axios.get<GetModelsResponse>(GET_MODELS_URL, opts);
    const families = new Set<OpenAIModelFamily>();
    const models = data.data.map(({ id }) => {
      families.add(getOpenAIModelFamily(id, "turbo"));
      return id;
    });

    // disable dall-e for trial keys due to very low per-day quota that tends to
    // render the key unusable.
    if (key.isTrial) {
      families.delete("dall-e");
    }

    // as of 2023-11-18, many keys no longer return the dalle3 model but still
    // have access to it via the api for whatever reason.
    // if (families.has("dall-e") && !models.find(({ id }) => id === "dall-e-3")) {
    //   families.delete("dall-e");
    // }

    // as of January 2024, 0314 model snapshots are only available on keys which
    // have used them in the past. these keys also seem to have 32k-0314 even
    // though they don't have the base gpt-4-32k model alias listed. if a key
    // has access to both 0314 models we will flag it as such and force add
    // gpt4-32k to its model families.
    if (
      ["gpt-4-0314", "gpt-4-32k-0314"].every((m) => models.find((n) => n === m))
    ) {
      this.log.info({ key: key.hash }, "Added gpt4-32k to -0314 key.");
      families.add("gpt4-32k");
    }

    // We want to update the key's model families here, but we don't want to
    // update its `lastChecked` timestamp because we need to let the liveness
    // check run before we can consider the key checked.

    const familiesArray = [...families];
    const keyFromPool = this.keys.find((k) => k.hash === key.hash)!;
    this.updateKey(key.hash, {
      modelSnapshots: models.filter((m) => m.match(/-\d{4}(-preview)?$/)),
      modelFamilies: familiesArray,
      lastChecked: keyFromPool.lastChecked,
    });
    return familiesArray;
  }

  private async maybeCreateOrganizationClones(key: OpenAIKey) {
    if (key.organizationId) return; // already cloned
    try {
      const opts = { headers: { Authorization: `Bearer ${key.key}` } };
      const { data } = await axios.get<GetOrganizationsResponse>(
        GET_ORGANIZATIONS_URL,
        opts
      );
      const organizations = data.data;
      const defaultOrg = organizations.find(({ is_default }) => is_default);
      this.updateKey(key.hash, { organizationId: defaultOrg?.id });
      if (organizations.length <= 1) return;

      this.log.info(
        { parent: key.hash, organizations: organizations.map((org) => org.id) },
        "Key is associated with multiple organizations; cloning key for each organization."
      );

      const ids = organizations
        .filter(({ is_default }) => !is_default)
        .map(({ id }) => id);
      this.cloneKey(key.hash, ids);
    } catch (error) {
      // Some keys do not have permission to list organizations, which is the
      // typical cause of this error.
      let info: string | Record<string, any>;
      const response = error.response;
      const expectedErrorCodes = ["invalid_api_key", "no_organization"];
      if (expectedErrorCodes.includes(response?.data?.error?.code)) {
        return;
      } else if (response) {
        info = { status: response.status, data: response.data };
      } else {
        info = error.message;
      }

      this.log.warn(
        { parent: key.hash, error: info },
        "Failed to fetch organizations for key."
      );
      return;
    }

    // It's possible that the keychecker may be stopped if all non-cloned keys
    // happened to be unusable, in which case this clnoe will never be checked
    // unless we restart the keychecker.
    if (!this.timeout) {
      this.log.warn(
        { parent: key.hash },
        "Restarting key checker to check cloned keys."
      );
      this.scheduleNextCheck();
    }
  }

  protected handleAxiosError(key: OpenAIKey, error: AxiosError) {
    if (error.response && OpenAIKeyChecker.errorIsOpenAIError(error)) {
      const { status, data } = error.response;
      if (status === 401) {
        this.log.warn(
          { key: key.hash, error: data },
          "Key is invalid or revoked. Disabling key."
        );
        this.updateKey(key.hash, {
          isDisabled: true,
          isRevoked: true,
          modelFamilies: ["turbo"],
        });
      } else if (status === 429) {
        switch (data.error.type) {
          case "insufficient_quota":
          case "billing_not_active":
          case "access_terminated":
            const isRevoked = data.error.type === "access_terminated";
            const isOverQuota = !isRevoked;
            const modelFamilies: OpenAIModelFamily[] = isRevoked
              ? ["turbo"]
              : key.modelFamilies;
            this.log.warn(
              { key: key.hash, rateLimitType: data.error.type, error: data },
              "Key returned a non-transient 429 error. Disabling key."
            );
            this.updateKey(key.hash, {
              isDisabled: true,
              isRevoked,
              isOverQuota,
              modelFamilies,
            });
            break;
          case "requests":
            // If we hit the text completion rate limit on a trial key, it is
            // likely being used by many proxies. We will disable the key since
            // it's just going to be constantly rate limited.
            const isTrial =
              Number(error.response.headers["x-ratelimit-limit-requests"]) <=
              250;

            if (isTrial) {
              this.log.warn(
                { key: key.hash, error: data },
                "Trial key is rate limited on text completion endpoint. This indicates the key is being used by several proxies at once and is not likely to be usable. Disabling key."
              );
              this.updateKey(key.hash, {
                isTrial,
                isDisabled: true,
                isOverQuota: true,
                modelFamilies: ["turbo"],
                lastChecked: Date.now(),
              });
            } else {
              this.log.warn(
                { key: key.hash, error: data },
                "Non-trial key is rate limited on text completion endpoint. This is unusual and may indicate a bug. Assuming key is operational."
              );
              this.updateKey(key.hash, { lastChecked: Date.now() });
            }
            break;
          case "tokens":
            // Hitting a token rate limit, even on a trial key, actually implies
            // that the key is valid and can generate completions, so we will
            // treat this as effectively a successful `testLiveness` call.
            this.log.info(
              { key: key.hash },
              "Key is currently `tokens` rate limited; assuming it is operational."
            );
            this.updateKey(key.hash, { lastChecked: Date.now() });
            break;
          default:
            this.log.error(
              { key: key.hash, rateLimitType: data.error.type, error: data },
              "Encountered unexpected rate limit error class while checking key. This may indicate a change in the API; please report this."
            );
            // We don't know what this error means, so we just let the key
            // through and maybe it will fail when someone tries to use it.
            this.updateKey(key.hash, { lastChecked: Date.now() });
        }
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

  /**
   * Tests whether the key is valid and has quota remaining. The request we send
   * is actually not valid, but keys which are revoked or out of quota will fail
   * with a 401 or 429 error instead of the expected 400 Bad Request error.
   * This lets us avoid test keys without spending any quota.
   *
   * We use the rate limit header to determine whether it's a trial key.
   */
  private async testLiveness(key: OpenAIKey): Promise<{ rateLimit: number }> {
    // What the hell this is doing:

    // OpenAI enforces separate rate limits for chat and text completions. Trial
    // keys have extremely low rate limits of 200 per day per API type. In order
    // to avoid wasting more valuable chat quota, we send an (invalid) chat
    // request to Babbage (a text completion model). Even though our request is
    // to the chat endpoint, we get text rate limit headers back because the
    // requested model determines the rate limit used, not the endpoint.

    // Once we have headers, we can determine:
    // 1. Is the key revoked? (401, OAI doesn't even validate the request)
    // 2. Is the key out of quota? (400, OAI will still validate the request)
    // 3. Is the key a trial key? (400, x-ratelimit-limit-requests: 200)

    // This might still cause issues if too many proxies are running a train on
    // the same trial key and even the text completion quota is exhausted, but
    // it should work better than the alternative.

    const payload = {
      model: "babbage-002",
      max_tokens: -1,
      messages: [{ role: "user", content: "" }],
    };
    const { headers, data } = await axios.post<OpenAIError>(
      POST_CHAT_COMPLETIONS_URL,
      payload,
      {
        headers: OpenAIKeyChecker.getHeaders(key),
        validateStatus: (status) => status === 400,
      }
    );
    const rateLimitHeader = headers["x-ratelimit-limit-requests"];
    const rateLimit = parseInt(rateLimitHeader) || 3500; // trials have 200

    // invalid_request_error is the expected error
    if (data.error.type !== "invalid_request_error") {
      this.log.warn(
        { key: key.hash, error: data },
        "Unexpected 400 error class while checking key; assuming key is valid, but this may indicate a change in the API."
      );
    }
    return { rateLimit };
  }

  static errorIsOpenAIError(
    error: AxiosError
  ): error is AxiosError<OpenAIError> {
    const data = error.response?.data as any;
    return data?.error?.type;
  }

  static getHeaders(key: OpenAIKey) {
    return {
      Authorization: `Bearer ${key.key}`,
      ...(key.organizationId && { "OpenAI-Organization": key.organizationId }),
    };
  }
}
