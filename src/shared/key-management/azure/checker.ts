import axios, { AxiosError } from "axios";
import { KeyCheckerBase } from "../key-checker-base";
import type { AzureOpenAIKey, AzureOpenAIKeyProvider } from "./provider";
import { getAzureOpenAIModelFamily } from "../../models";

const MIN_CHECK_INTERVAL = 3 * 1000; // 3 seconds
const KEY_CHECK_PERIOD = 3 * 60 * 1000; // 3 minutes
const AZURE_HOST = process.env.AZURE_HOST || "%RESOURCE_NAME%.openai.azure.com";
const POST_CHAT_COMPLETIONS = (resourceName: string, deploymentId: string) =>
  `https://${AZURE_HOST.replace(
    "%RESOURCE_NAME%",
    resourceName
  )}/openai/deployments/${deploymentId}/chat/completions?api-version=2023-09-01-preview`;

type AzureError = {
  error: {
    message: string;
    type: string | null;
    param: string;
    code: string;
    status: number;
  };
};
type UpdateFn = typeof AzureOpenAIKeyProvider.prototype.update;

export class AzureOpenAIKeyChecker extends KeyCheckerBase<AzureOpenAIKey> {
  constructor(keys: AzureOpenAIKey[], updateKey: UpdateFn) {
    super(keys, {
      service: "azure",
      keyCheckPeriod: KEY_CHECK_PERIOD,
      minCheckInterval: MIN_CHECK_INTERVAL,
      recurringChecksEnabled: false,
      updateKey,
    });
  }

  protected async testKeyOrFail(key: AzureOpenAIKey) {
    const model = await this.testModel(key);
    this.log.info({ key: key.hash, deploymentModel: model }, "Checked key.");
    this.updateKey(key.hash, { modelFamilies: [model] });
  }

  protected handleAxiosError(key: AzureOpenAIKey, error: AxiosError) {
    if (error.response && AzureOpenAIKeyChecker.errorIsAzureError(error)) {
      const data = error.response.data;
      const status = data.error.status;
      const errorType = data.error.code || data.error.type;
      switch (errorType) {
        case "DeploymentNotFound":
          this.log.warn(
            { key: key.hash, errorType, error: error.response.data },
            "Key is revoked or deployment ID is incorrect. Disabling key."
          );
          return this.updateKey(key.hash, {
            isDisabled: true,
            isRevoked: true,
          });
        case "401":
          this.log.warn(
            { key: key.hash, errorType, error: error.response.data },
            "Key is disabled or incorrect. Disabling key."
          );
          return this.updateKey(key.hash, {
            isDisabled: true,
            isRevoked: true,
          });
        case "429":
          this.log.warn(
            { key: key.hash, errorType, error: error.response.data },
            "Key is rate limited. Rechecking key in 1 minute."
          );
          this.updateKey(key.hash, { lastChecked: Date.now() });
          setTimeout(async () => {
            this.log.info(
              { key: key.hash },
              "Rechecking Azure key after rate limit."
            );
            await this.checkKey(key);
          }, 1000 * 60);
          return;
        default:
          this.log.error(
            { key: key.hash, errorType, error: error.response.data, status },
            "Unknown Azure API error while checking key. Please report this."
          );
          return this.updateKey(key.hash, { lastChecked: Date.now() });
      }
    }

    const { response, code } = error;
    if (code === "ENOTFOUND") {
      this.log.warn(
        { key: key.hash, error: error.message },
        "Resource name is probably incorrect. Disabling key."
      );
      return this.updateKey(key.hash, { isDisabled: true, isRevoked: true });
    }

    const { headers, status, data } = response ?? {};
    this.log.error(
      { key: key.hash, status, headers, data, error: error.message },
      "Network error while checking key; trying this key again in a minute."
    );
    const oneMinute = 60 * 1000;
    const next = Date.now() - (KEY_CHECK_PERIOD - oneMinute);
    this.updateKey(key.hash, { lastChecked: next });
  }

  private async testModel(key: AzureOpenAIKey) {
    const { apiKey, deploymentId, resourceName } =
      AzureOpenAIKeyChecker.getCredentialsFromKey(key);
    const url = POST_CHAT_COMPLETIONS(resourceName, deploymentId);
    const testRequest = {
      max_tokens: 1,
      stream: false,
      messages: [{ role: "user", content: "" }],
    };
    const { data } = await axios.post(url, testRequest, {
      headers: { "Content-Type": "application/json", "api-key": apiKey },
    });

    const family = getAzureOpenAIModelFamily(data.model);

    // Azure returns "gpt-4" even for GPT-4 Turbo, so we need further checks.
    // Otherwise we can use the model family Azure returned.
    if (family !== "azure-gpt4") {
      return family;
    }

    // Try to send an oversized prompt. GPT-4 Turbo can handle this but regular
    // GPT-4 will return a Bad Request error.
    const contextText = {
      max_tokens: 9000,
      stream: false,
      temperature: 0,
      seed: 0,
      messages: [{ role: "user", content: "" }],
    };
    const { data: contextTest, status } = await axios.post(url, contextText, {
      headers: { "Content-Type": "application/json", "api-key": apiKey },
      validateStatus: (status) => status === 400 || status === 200,
    });
    const code = contextTest.error?.code;
    this.log.debug({ code, status }, "Performed Azure GPT4 context size test.");

    if (code === "context_length_exceeded") return "azure-gpt4";
    return "azure-gpt4-turbo";
  }

  static errorIsAzureError(error: AxiosError): error is AxiosError<AzureError> {
    const data = error.response?.data as any;
    return data?.error?.code || data?.error?.type;
  }

  static getCredentialsFromKey(key: AzureOpenAIKey) {
    const [resourceName, deploymentId, apiKey] = key.key.split(":");
    if (!resourceName || !deploymentId || !apiKey) {
      throw new Error(
        "Invalid Azure credential format. Refer to .env.example and ensure your credentials are in the format RESOURCE_NAME:DEPLOYMENT_ID:API_KEY with commas between each credential set."
      );
    }
    return { resourceName, deploymentId, apiKey };
  }
}
