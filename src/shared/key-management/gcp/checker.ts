import axios, { AxiosError } from "axios";
import crypto from "crypto";
import { KeyCheckerBase } from "../key-checker-base";
import type { GcpKey, GcpKeyProvider } from "./provider";
import { GcpModelFamily } from "../../models";

const MIN_CHECK_INTERVAL = 3 * 1000; // 3 seconds
const KEY_CHECK_PERIOD = 90 * 60 * 1000; // 90 minutes
const GCP_HOST =
  process.env.GCP_HOST || "%REGION%-aiplatform.googleapis.com";
const POST_STREAM_RAW_URL = (project: string, region: string, model: string) =>
  `https://${GCP_HOST.replace("%REGION%", region)}/v1/projects/${project}/locations/${region}/publishers/anthropic/models/${model}:streamRawPredict`;
const TEST_MESSAGES = [
  { role: "user", content: "Hi!" },
  { role: "assistant", content: "Hello!" },
];

type UpdateFn = typeof GcpKeyProvider.prototype.update;

export class GcpKeyChecker extends KeyCheckerBase<GcpKey> {
  constructor(keys: GcpKey[], updateKey: UpdateFn) {
    super(keys, {
      service: "gcp",
      keyCheckPeriod: KEY_CHECK_PERIOD,
      minCheckInterval: MIN_CHECK_INTERVAL,
      updateKey,
    });
  }

  protected async testKeyOrFail(key: GcpKey) {
    let checks: Promise<boolean>[] = [];
    const isInitialCheck = !key.lastChecked;
    if (isInitialCheck) {
      checks = [
        this.invokeModel("claude-3-haiku@20240307", key, true),
        this.invokeModel("claude-3-sonnet@20240229", key, true),
        this.invokeModel("claude-3-opus@20240229", key, true),
        this.invokeModel("claude-3-5-sonnet@20240620", key, true),
      ];

      const [sonnet, haiku, opus, sonnet35] =
        await Promise.all(checks);
      
      this.log.debug(
        { key: key.hash, sonnet, haiku, opus, sonnet35 },
        "GCP model initial tests complete."
      );

      const families: GcpModelFamily[] = [];
      if (sonnet || sonnet35 || haiku) families.push("gcp-claude");
      if (opus) families.push("gcp-claude-opus");

      if (families.length === 0) {
        this.log.warn(
          { key: key.hash },
          "Key does not have access to any models; disabling."
        );
        return this.updateKey(key.hash, { isDisabled: true });
      }

      this.updateKey(key.hash, {
        sonnetEnabled: sonnet,
        haikuEnabled: haiku,
        sonnet35Enabled: sonnet35,
        modelFamilies: families,
      });
    } else {
      if (key.haikuEnabled) {
        this.invokeModel("claude-3-haiku@20240307", key, false)
      } else if (key.sonnetEnabled) {
        this.invokeModel("claude-3-sonnet@20240229", key, false)
      } else if (key.sonnet35Enabled) {
        this.invokeModel("claude-3-5-sonnet@20240620", key, false)
      } else {
        this.invokeModel("claude-3-opus@20240229", key, false)
      }

      this.log.debug(
        { key: key.hash},
        "GCP key check complete."
      );
    }

    this.log.info(
      {
        key: key.hash,
        families: key.modelFamilies,
      },
      "Checked key."
    );
  }

  protected handleAxiosError(key: GcpKey, error: AxiosError) {
    if (error.response && GcpKeyChecker.errorIsGcpError(error)) {
      const { status, data } = error.response;
      if (status === 400 || status === 401 || status === 403) {
        this.log.warn(
          { key: key.hash, error: data },
          "Key is invalid or revoked. Disabling key."
        );
        this.updateKey(key.hash, { isDisabled: true, isRevoked: true });
      } else if (status === 429) {
        this.log.warn(
          { key: key.hash, error: data },
          "Key is rate limited. Rechecking in 10 seconds."
        );
        const next = Date.now() - (KEY_CHECK_PERIOD - 10 * 1000);
        this.updateKey(key.hash, { lastChecked: next });
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
   * Attempt to invoke the given model with the given key.  Returns true if the
   * key has access to the model, false if it does not. Throws an error if the
   * key is disabled.
   */
  private async invokeModel(model: string, key: GcpKey, initial: boolean) {
    const creds = GcpKeyChecker.getCredentialsFromKey(key);
    const signedJWT = await GcpKeyChecker.createSignedJWT(creds.clientEmail, creds.privateKey)
    const [accessToken, jwtError] = await GcpKeyChecker.exchangeJwtForAccessToken(signedJWT)
    if (accessToken === null) {
      this.log.warn(
        { key: key.hash, jwtError },
        "Unable to get the access token"
      );
      return false;
    }
    const payload = {
      max_tokens: 1,
      messages: TEST_MESSAGES,
      anthropic_version: "vertex-2023-10-16",
    };
    const { data, status } = await axios.post(
      POST_STREAM_RAW_URL(creds.projectId, creds.region, model),
      payload,
      { 
        headers: GcpKeyChecker.getRequestHeaders(accessToken),
        validateStatus: initial ? function (status: number) {
          return (status >= 200 && status < 300) || status === 400 || status === 401 || status === 403;
        } : undefined
      }
    );
    this.log.debug({ data }, "Response from GCP");

    if (status === 400 || status === 401 || status === 403) {
      return false;
    }

    return true;
  }

  static errorIsGcpError(error: AxiosError): error is AxiosError {
    const data = error.response?.data as any;
    if (Array.isArray(data)) {
      return data.length > 0 && data[0]?.error?.message;
    } else {
      return data?.error?.message;
    }
  }

  static async createSignedJWT(email: string, pkey: string): Promise<string> {
    let cryptoKey = await crypto.subtle.importKey(
      "pkcs8",
      GcpKeyChecker.str2ab(atob(pkey)),
      {
        name: "RSASSA-PKCS1-v1_5",
        hash: { name: "SHA-256" },
      },
      false,
      ["sign"]
    );

    const authUrl = "https://www.googleapis.com/oauth2/v4/token";
    const issued = Math.floor(Date.now() / 1000);
    const expires = issued + 600;

    const header = {
      alg: "RS256",
      typ: "JWT",
    };

    const payload = {
      iss: email,
      aud: authUrl,
      iat: issued,
      exp: expires,
      scope: "https://www.googleapis.com/auth/cloud-platform",
    };

    const encodedHeader = GcpKeyChecker.urlSafeBase64Encode(JSON.stringify(header));
    const encodedPayload = GcpKeyChecker.urlSafeBase64Encode(JSON.stringify(payload));

    const unsignedToken = `${encodedHeader}.${encodedPayload}`;

    const signature = await crypto.subtle.sign(
      "RSASSA-PKCS1-v1_5",
      cryptoKey,
      GcpKeyChecker.str2ab(unsignedToken)
    );

    const encodedSignature = GcpKeyChecker.urlSafeBase64Encode(signature);
    return `${unsignedToken}.${encodedSignature}`;
  }

  static async exchangeJwtForAccessToken(signed_jwt: string): Promise<[string | null, string]> {
    const auth_url = "https://www.googleapis.com/oauth2/v4/token";
    const params = {
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: signed_jwt,
    };

    const r = await fetch(auth_url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: Object.entries(params)
        .map(([k, v]) => `${k}=${v}`)
        .join("&"),
    }).then((res) => res.json());

    if (r.access_token) {
      return [r.access_token, ""];
    }

    return [null, JSON.stringify(r)];
  }

  static str2ab(str: string): ArrayBuffer {
    const buffer = new ArrayBuffer(str.length);
    const bufferView = new Uint8Array(buffer);
    for (let i = 0; i < str.length; i++) {
      bufferView[i] = str.charCodeAt(i);
    }
    return buffer;
  }

  static urlSafeBase64Encode(data: string | ArrayBuffer): string {
    let base64: string;
    if (typeof data === "string") {
      base64 = btoa(encodeURIComponent(data).replace(/%([0-9A-F]{2})/g, (match, p1) => String.fromCharCode(parseInt("0x" + p1, 16))));
    } else {
      base64 = btoa(String.fromCharCode(...new Uint8Array(data)));
    }
    return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }

  static getRequestHeaders(accessToken: string) {
    return { "Authorization": `Bearer ${accessToken}`, "Content-Type": "application/json" };
  }

  static getCredentialsFromKey(key: GcpKey) {
    const [projectId, clientEmail, region, rawPrivateKey] = key.key.split(":");
    if (!projectId || !clientEmail || !region || !rawPrivateKey) {
      throw new Error("Invalid GCP key");
    }
    const privateKey = rawPrivateKey
      .replace(/-----BEGIN PRIVATE KEY-----|-----END PRIVATE KEY-----|\r|\n|\\n/g, '')
      .trim();
  
    return { projectId, clientEmail, region, privateKey };
  }
}
