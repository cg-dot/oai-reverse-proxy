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
    this.log.info(
      { key: key.hash, deploymentModel: model },
      "Checked key."
    );
    this.updateKey(key.hash, { modelFamilies: [model] });
  }

  // provided api-key header isn't valid (401)
  // {
  //   "error": {
  //     "code": "401",
  //     "message": "Access denied due to invalid subscription key or wrong API endpoint. Make sure to provide a valid key for an active subscription and use a correct regional API endpoint for your resource."
  //   }
  // }

  // api key correct but deployment id is wrong (404)
  // {
  //   "error": {
  //     "code": "DeploymentNotFound",
  //     "message": "The API deployment for this resource does not exist. If you created the deployment within the last 5 minutes, please wait a moment and try again."
  //   }
  // }

  // resource name is wrong (node will throw ENOTFOUND)

  // rate limited (429)
  // TODO: try to reproduce this

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

    return getAzureOpenAIModelFamily(data.model);
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
