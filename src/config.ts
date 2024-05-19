import crypto from "crypto";
import dotenv from "dotenv";
import type firebase from "firebase-admin";
import path from "path";
import pino from "pino";
import type { ModelFamily } from "./shared/models";
import { MODEL_FAMILIES } from "./shared/models";

dotenv.config();

const startupLogger = pino({ level: "debug" }).child({ module: "startup" });
const isDev = process.env.NODE_ENV !== "production";

export const DATA_DIR = path.join(__dirname, "..", "data");
export const USER_ASSETS_DIR = path.join(DATA_DIR, "user-files");

type Config = {
  /** The port the proxy server will listen on. */
  port: number;
  /** The network interface the proxy server will listen on. */
  bindAddress: string;
  /** Comma-delimited list of OpenAI API keys. */
  openaiKey?: string;
  /** Comma-delimited list of Anthropic API keys. */
  anthropicKey?: string;
  /**
   * Comma-delimited list of Google AI API keys. Note that these are not the
   * same as the GCP keys/credentials used for Vertex AI; the models are the
   * same but the APIs are different. Vertex is the GCP product for enterprise.
   **/
  googleAIKey?: string;
  /**
   * Comma-delimited list of Mistral AI API keys.
   */
  mistralAIKey?: string;
  /**
   * Comma-delimited list of AWS credentials. Each credential item should be a
   * colon-delimited list of access key, secret key, and AWS region.
   *
   * The credentials must have access to the actions `bedrock:InvokeModel` and
   * `bedrock:InvokeModelWithResponseStream`. You must also have already
   * provisioned the necessary models in your AWS account, on the specific
   * regions specified for each credential. Models are region-specific.
   *
   * @example `AWS_CREDENTIALS=access_key_1:secret_key_1:us-east-1,access_key_2:secret_key_2:us-west-2`
   */
  awsCredentials?: string;
  /**
   * Comma-delimited list of Azure OpenAI credentials. Each credential item
   * should be a colon-delimited list of Azure resource name, deployment ID, and
   * API key.
   *
   * The resource name is the subdomain in your Azure OpenAI deployment's URL,
   * e.g. `https://resource-name.openai.azure.com
   *
   * @example `AZURE_CREDENTIALS=resource_name_1:deployment_id_1:api_key_1,resource_name_2:deployment_id_2:api_key_2`
   */
  azureCredentials?: string;
  /**
   * The proxy key to require for requests. Only applicable if the user
   * management mode is set to 'proxy_key', and required if so.
   */
  proxyKey?: string;
  /**
   * The admin key used to access the /admin API or UI. Required if the user
   * management mode is set to 'user_token'.
   */
  adminKey?: string;
  /**
   * The password required to view the service info/status page. If not set, the
   * info page will be publicly accessible.
   */
  serviceInfoPassword?: string;
  /**
   * Which user management mode to use.
   * - `none`: No user management. Proxy is open to all requests with basic
   *   abuse protection.
   * - `proxy_key`: A specific proxy key must be provided in the Authorization
   *   header to use the proxy.
   * - `user_token`: Users must be created via by admins and provide their
   *   personal access token in the Authorization header to use the proxy.
   *   Configure this function and add users via the admin API or UI.
   */
  gatekeeper: "none" | "proxy_key" | "user_token";
  /**
   * Persistence layer to use for user management.
   * - `memory`: Users are stored in memory and are lost on restart (default)
   * - `firebase_rtdb`: Users are stored in a Firebase Realtime Database;
   *   requires `firebaseKey` and `firebaseRtdbUrl` to be set.
   */
  gatekeeperStore: "memory" | "firebase_rtdb";
  /** URL of the Firebase Realtime Database if using the Firebase RTDB store. */
  firebaseRtdbUrl?: string;
  /**
   * Base64-encoded Firebase service account key if using the Firebase RTDB
   * store. Note that you should encode the *entire* JSON key file, not just the
   * `private_key` field inside it.
   */
  firebaseKey?: string;
  /**
   * Maximum number of IPs allowed per user token.
   * Users with the manually-assigned `special` role are exempt from this limit.
   * - Defaults to 0, which means that users are not IP-limited.
   */
  maxIpsPerUser: number;
  /**
   * Whether a user token should be automatically disabled if it exceeds the
   * `maxIpsPerUser` limit, or if only connections from new IPs are be rejected.
   */
  maxIpsAutoBan: boolean;
  /**
   * Which captcha verification mode to use. Requires `user_token` gatekeeper.
   * Allows users to automatically obtain a token by solving a captcha.
   * - `none`: No captcha verification; tokens are issued manually.
   * - `proof_of_work`: Users must solve an Argon2 proof of work to obtain a
   *    temporary usertoken valid for a limited period.
   */
  captchaMode: "none" | "proof_of_work";
  /**
   * Duration in hours for which a PoW-issued temporary user token is valid.
   */
  powTokenHours: number;
  /** Maximum number of IPs allowed per PoW-issued temporary user token. */
  powTokenMaxIps: number;
  /**
   * Difficulty level for the proof-of-work. Refer to docs/pow-captcha.md for
   * details on the available modes.
   */
  powDifficultyLevel: "low" | "medium" | "high" | "extreme";
  /** Per-user limit for requests per minute to text and chat models. */
  textModelRateLimit: number;
  /** Per-user limit for requests per minute to image generation models. */
  imageModelRateLimit: number;
  /**
   * For OpenAI, the maximum number of context tokens (prompt + max output) a
   * user can request before their request is rejected.
   * Context limits can help prevent excessive spend.
   * - Defaults to 0, which means no limit beyond OpenAI's stated maximums.
   */
  maxContextTokensOpenAI: number;
  /**
   * For Anthropic, the maximum number of context tokens a user can request.
   * Claude context limits can prevent requests from tying up concurrency slots
   * for too long, which can lengthen queue times for other users.
   * - Defaults to 0, which means no limit beyond Anthropic's stated maximums.
   */
  maxContextTokensAnthropic: number;
  /** For OpenAI, the maximum number of sampled tokens a user can request. */
  maxOutputTokensOpenAI: number;
  /** For Anthropic, the maximum number of sampled tokens a user can request. */
  maxOutputTokensAnthropic: number;
  /** Whether requests containing the following phrases should be rejected. */
  rejectPhrases: string[];
  /** Message to return when rejecting requests. */
  rejectMessage: string;
  /** Verbosity level of diagnostic logging. */
  logLevel: "trace" | "debug" | "info" | "warn" | "error";
  /**
   * Whether to allow the usage of AWS credentials which could be logging users'
   * model invocations. By default, such keys are treated as if they were
   * disabled because users may not be aware that their usage is being logged.
   *
   * Some credentials do not have the policy attached that allows the proxy to
   * confirm logging status, in which case the proxy assumes that logging could
   * be enabled and will refuse to use the key. If you still want to use such a
   * key and can't attach the policy, you can set this to true.
   */
  allowAwsLogging?: boolean;
  /** Whether prompts and responses should be logged to persistent storage. */
  promptLogging?: boolean;
  /** Which prompt logging backend to use. */
  promptLoggingBackend?: "google_sheets" | "file";
  /** Prefix for prompt logging files when using the file backend. */
  promptLoggingFilePrefix?: string;
  /** Base64-encoded Google Sheets API key. */
  googleSheetsKey?: string;
  /** Google Sheets spreadsheet ID. */
  googleSheetsSpreadsheetId?: string;
  /** Whether to periodically check keys for usage and validity. */
  checkKeys: boolean;
  /** Whether to publicly show total token costs on the info page. */
  showTokenCosts: boolean;
  /**
   * Comma-separated list of origins to block. Requests matching any of these
   * origins or referers will be rejected.
   * - Partial matches are allowed, so `reddit` will match `www.reddit.com`.
   * - Include only the hostname, not the protocol or path, e.g:
   *  `reddit.com,9gag.com,gaiaonline.com`
   */
  blockedOrigins?: string;
  /** Message to return when rejecting requests from blocked origins. */
  blockMessage?: string;
  /** Destination URL to redirect blocked requests to, for non-JSON requests. */
  blockRedirect?: string;
  /** Which model families to allow requests for. Applies only to OpenAI. */
  allowedModelFamilies: ModelFamily[];
  /**
   * The number of (LLM) tokens a user can consume before requests are rejected.
   * Limits include both prompt and response tokens. `special` users are exempt.
   * - Defaults to 0, which means no limit.
   * - Changes are not automatically applied to existing users. Use the
   * admin API or UI to update existing users, or use the QUOTA_REFRESH_PERIOD
   * setting to periodically set all users' quotas to these values.
   */
  tokenQuota: { [key in ModelFamily]: number };
  /**
   * The period over which to enforce token quotas. Quotas will be fully reset
   * at the start of each period, server time. Unused quota does not roll over.
   * You can also provide a cron expression for a custom schedule. If not set,
   * quotas will never automatically refresh.
   * - Defaults to unset, which means quotas will never automatically refresh.
   */
  quotaRefreshPeriod?: "hourly" | "daily" | string;
  /** Whether to allow users to change their own nicknames via the UI. */
  allowNicknameChanges: boolean;
  /** Whether to show recent DALL-E image generations on the homepage. */
  showRecentImages: boolean;
  /**
   * If true, cookies will be set without the `Secure` attribute, allowing
   * the admin UI to used over HTTP.
   */
  useInsecureCookies: boolean;
  /**
   * Whether to use a more minimal public Service Info page with static content.
   * Disables all stats pertaining to traffic, prompt/token usage, and queues.
   * The full info page will appear if you have signed in as an admin using the
   * configured ADMIN_KEY and go to /admin/service-info.
   **/
  staticServiceInfo?: boolean;
  /**
   * Trusted proxy hops. If you are deploying the server behind a reverse proxy
   * (Nginx, Cloudflare Tunnel, AWS WAF, etc.) the IP address of incoming
   * requests will be the IP address of the proxy, not the actual user.
   *
   * Depending on your hosting configuration, there may be multiple proxies/load
   * balancers between your server and the user. Each one will append the
   * incoming IP address to the `X-Forwarded-For` header. The user's real IP
   * address will be the first one in the list, assuming the header has not been
   * tampered with. Setting this value correctly ensures that the server doesn't
   * trust values in `X-Forwarded-For` not added by trusted proxies.
   *
   * In order for the server to determine the user's real IP address, you need
   * to tell it how many proxies are between the user and the server so it can
   * select the correct IP address from the `X-Forwarded-For` header.
   *
   * *WARNING:* If you set it incorrectly, the proxy will either record the
   * wrong IP address, or it will be possible for users to spoof their IP
   * addresses and bypass rate limiting. Check the request logs to see what
   * incoming X-Forwarded-For values look like.
   *
   * Examples:
   *  - X-Forwarded-For: "34.1.1.1, 172.1.1.1, 10.1.1.1" => trustedProxies: 3
   *  - X-Forwarded-For: "34.1.1.1" => trustedProxies: 1
   *  - no X-Forwarded-For header => trustedProxies: 0 (the actual IP of the incoming request will be used)
   *
   * As of 2024/01/08:
   * For HuggingFace or Cloudflare Tunnel, use 1.
   * For Render, use 3.
   * For deployments not behind a load balancer, use 0.
   *
   * You should double check against your actual request logs to be sure.
   *
   * Defaults to 1, as most deployments are on HuggingFace or Cloudflare Tunnel.
   */
  trustedProxies?: number;
  /**
   * Whether to allow OpenAI tool usage.  The proxy doesn't impelment any
   * support for tools/function calling but can pass requests and responses as
   * is. Note that the proxy also cannot accurately track quota usage for
   * requests involving tools, so you must opt in to this feature at your own
   * risk.
   */
  allowOpenAIToolUsage?: boolean;
  /**
   * Whether to allow prompts containing images, for use with multimodal models.
   * Avoid giving this to untrusted users, as they can submit illegal content.
   *
   * Applies to GPT-4 Vision and Claude Vision. Users with `special` role are
   * exempt from this restriction.
   */
  allowImagePrompts?: boolean;
  /**
   * Allows overriding the default proxy endpoint route. Defaults to /proxy.
   * A leading slash is required.
   */
  proxyEndpointRoute: string;
  /**
   * If set, only requests from these IP addresses will be permitted to use the
   * admin API and UI. Provide a comma-separated list of IP addresses or CIDR
   * ranges. If not set, the admin API and UI will be open to all requests.
   */
  adminWhitelist: string[];
  /**
   * If set, requests from these IP addresses will be blocked from using the
   * application. Provide a comma-separated list of IP addresses or CIDR ranges.
   * If not set, no IP addresses will be blocked.
   *
   * Takes precedence over the adminWhitelist.
   */
  ipBlacklist: string[];
};

// To change configs, create a file called .env in the root directory.
// See .env.example for an example.
export const config: Config = {
  port: getEnvWithDefault("PORT", 7860),
  bindAddress: getEnvWithDefault("BIND_ADDRESS", "0.0.0.0"),
  openaiKey: getEnvWithDefault("OPENAI_KEY", ""),
  anthropicKey: getEnvWithDefault("ANTHROPIC_KEY", ""),
  googleAIKey: getEnvWithDefault("GOOGLE_AI_KEY", ""),
  mistralAIKey: getEnvWithDefault("MISTRAL_AI_KEY", ""),
  awsCredentials: getEnvWithDefault("AWS_CREDENTIALS", ""),
  azureCredentials: getEnvWithDefault("AZURE_CREDENTIALS", ""),
  proxyKey: getEnvWithDefault("PROXY_KEY", ""),
  adminKey: getEnvWithDefault("ADMIN_KEY", ""),
  serviceInfoPassword: getEnvWithDefault("SERVICE_INFO_PASSWORD", ""),
  gatekeeper: getEnvWithDefault("GATEKEEPER", "none"),
  gatekeeperStore: getEnvWithDefault("GATEKEEPER_STORE", "memory"),
  maxIpsPerUser: getEnvWithDefault("MAX_IPS_PER_USER", 0),
  maxIpsAutoBan: getEnvWithDefault("MAX_IPS_AUTO_BAN", false),
  captchaMode: getEnvWithDefault("CAPTCHA_MODE", "none"),
  powTokenHours: getEnvWithDefault("POW_TOKEN_HOURS", 24),
  powTokenMaxIps: getEnvWithDefault("POW_TOKEN_MAX_IPS", 2),
  powDifficultyLevel: getEnvWithDefault("POW_DIFFICULTY_LEVEL", "low"),
  firebaseRtdbUrl: getEnvWithDefault("FIREBASE_RTDB_URL", undefined),
  firebaseKey: getEnvWithDefault("FIREBASE_KEY", undefined),
  textModelRateLimit: getEnvWithDefault("TEXT_MODEL_RATE_LIMIT", 4),
  imageModelRateLimit: getEnvWithDefault("IMAGE_MODEL_RATE_LIMIT", 4),
  maxContextTokensOpenAI: getEnvWithDefault("MAX_CONTEXT_TOKENS_OPENAI", 16384),
  maxContextTokensAnthropic: getEnvWithDefault(
    "MAX_CONTEXT_TOKENS_ANTHROPIC",
    0
  ),
  maxOutputTokensOpenAI: getEnvWithDefault(
    ["MAX_OUTPUT_TOKENS_OPENAI", "MAX_OUTPUT_TOKENS"],
    400
  ),
  maxOutputTokensAnthropic: getEnvWithDefault(
    ["MAX_OUTPUT_TOKENS_ANTHROPIC", "MAX_OUTPUT_TOKENS"],
    400
  ),
  allowedModelFamilies: getEnvWithDefault("ALLOWED_MODEL_FAMILIES", [
    "turbo",
    "gpt4",
    "gpt4-32k",
    "gpt4-turbo",
    "gpt4o",
    "claude",
    "claude-opus",
    "gemini-pro",
    "mistral-tiny",
    "mistral-small",
    "mistral-medium",
    "mistral-large",
    "aws-claude",
    "aws-claude-opus",
    "azure-turbo",
    "azure-gpt4",
    "azure-gpt4-32k",
    "azure-gpt4-turbo",
    "azure-gpt4o",
  ]),
  rejectPhrases: parseCsv(getEnvWithDefault("REJECT_PHRASES", "")),
  rejectMessage: getEnvWithDefault(
    "REJECT_MESSAGE",
    "This content violates /aicg/'s acceptable use policy."
  ),
  logLevel: getEnvWithDefault("LOG_LEVEL", "info"),
  checkKeys: getEnvWithDefault("CHECK_KEYS", !isDev),
  showTokenCosts: getEnvWithDefault("SHOW_TOKEN_COSTS", false),
  allowAwsLogging: getEnvWithDefault("ALLOW_AWS_LOGGING", false),
  promptLogging: getEnvWithDefault("PROMPT_LOGGING", false),
  promptLoggingBackend: getEnvWithDefault("PROMPT_LOGGING_BACKEND", undefined),
  promptLoggingFilePrefix: getEnvWithDefault(
    "PROMPT_LOGGING_FILE_PREFIX",
    "prompt-logs"
  ),
  googleSheetsKey: getEnvWithDefault("GOOGLE_SHEETS_KEY", undefined),
  googleSheetsSpreadsheetId: getEnvWithDefault(
    "GOOGLE_SHEETS_SPREADSHEET_ID",
    undefined
  ),
  blockedOrigins: getEnvWithDefault("BLOCKED_ORIGINS", undefined),
  blockMessage: getEnvWithDefault(
    "BLOCK_MESSAGE",
    "You must be over the age of majority in your country to use this service."
  ),
  blockRedirect: getEnvWithDefault("BLOCK_REDIRECT", "https://www.9gag.com"),
  tokenQuota: MODEL_FAMILIES.reduce(
    (acc, family: ModelFamily) => {
      acc[family] = getEnvWithDefault(
        `TOKEN_QUOTA_${family.toUpperCase().replace(/-/g, "_")}`,
        0
      ) as number;
      return acc;
    },
    {} as { [key in ModelFamily]: number }
  ),
  quotaRefreshPeriod: getEnvWithDefault("QUOTA_REFRESH_PERIOD", undefined),
  allowNicknameChanges: getEnvWithDefault("ALLOW_NICKNAME_CHANGES", true),
  showRecentImages: getEnvWithDefault("SHOW_RECENT_IMAGES", true),
  useInsecureCookies: getEnvWithDefault("USE_INSECURE_COOKIES", isDev),
  staticServiceInfo: getEnvWithDefault("STATIC_SERVICE_INFO", false),
  trustedProxies: getEnvWithDefault("TRUSTED_PROXIES", 1),
  allowOpenAIToolUsage: getEnvWithDefault("ALLOW_OPENAI_TOOL_USAGE", false),
  allowImagePrompts: getEnvWithDefault("ALLOW_IMAGE_PROMPTS", false),
  proxyEndpointRoute: getEnvWithDefault("PROXY_ENDPOINT_ROUTE", "/proxy"),
  adminWhitelist: parseCsv(getEnvWithDefault("ADMIN_WHITELIST", "0.0.0.0/0")),
  ipBlacklist: parseCsv(getEnvWithDefault("IP_BLACKLIST", "")),
} as const;

function generateSigningKey() {
  if (process.env.COOKIE_SECRET !== undefined) {
    // legacy, replaced by SIGNING_KEY
    return process.env.COOKIE_SECRET;
  } else if (process.env.SIGNING_KEY !== undefined) {
    return process.env.SIGNING_KEY;
  }

  const secrets = [
    config.adminKey,
    config.openaiKey,
    config.anthropicKey,
    config.googleAIKey,
    config.mistralAIKey,
    config.awsCredentials,
    config.azureCredentials,
  ];
  if (secrets.filter((s) => s).length === 0) {
    startupLogger.warn(
      "No SIGNING_KEY or secrets are set. All sessions, cookies, and proofs of work will be invalidated on restart."
    );
    return crypto.randomBytes(32).toString("hex");
  }

  startupLogger.info("No SIGNING_KEY set; one will be generated from secrets.");
  startupLogger.info(
    "It's recommended to set SIGNING_KEY explicitly to ensure users' sessions and cookies always persist across restarts."
  );
  const seed = secrets.map((s) => s || "n/a").join("");
  return crypto.createHash("sha256").update(seed).digest("hex");
}

const signingKey = generateSigningKey();
export const COOKIE_SECRET = signingKey;

export async function assertConfigIsValid() {
  if (process.env.MODEL_RATE_LIMIT !== undefined) {
    const limit =
      parseInt(process.env.MODEL_RATE_LIMIT, 10) || config.textModelRateLimit;

    config.textModelRateLimit = limit;
    config.imageModelRateLimit = Math.max(Math.floor(limit / 2), 1);

    startupLogger.warn(
      { textLimit: limit, imageLimit: config.imageModelRateLimit },
      "MODEL_RATE_LIMIT is deprecated. Use TEXT_MODEL_RATE_LIMIT and IMAGE_MODEL_RATE_LIMIT instead."
    );
  }

  if (config.promptLogging && !config.promptLoggingBackend) {
    throw new Error(
      "Prompt logging is enabled but no backend is configured. Set PROMPT_LOGGING_BACKEND to 'google_sheets' or 'file'."
    );
  }

  if (!["none", "proxy_key", "user_token"].includes(config.gatekeeper)) {
    throw new Error(
      `Invalid gatekeeper mode: ${config.gatekeeper}. Must be one of: none, proxy_key, user_token.`
    );
  }

  if (config.gatekeeper === "user_token" && !config.adminKey) {
    throw new Error(
      "`user_token` gatekeeper mode requires an `ADMIN_KEY` to be set."
    );
  }

  if (config.captchaMode === "proof_of_work" && config.gatekeeper !== "user_token") {
    throw new Error(
      "Captcha mode 'proof_of_work' requires gatekeeper mode 'user_token'."
    );
  }

  if (config.gatekeeper === "proxy_key" && !config.proxyKey) {
    throw new Error(
      "`proxy_key` gatekeeper mode requires a `PROXY_KEY` to be set."
    );
  }

  if (
    config.gatekeeperStore === "firebase_rtdb" &&
    (!config.firebaseKey || !config.firebaseRtdbUrl)
  ) {
    throw new Error(
      "Firebase RTDB store requires `FIREBASE_KEY` and `FIREBASE_RTDB_URL` to be set."
    );
  }

  // Ensure forks which add new secret-like config keys don't unwittingly expose
  // them to users.
  for (const key of getKeys(config)) {
    const maybeSensitive = ["key", "credentials", "secret", "password"].some(
      (sensitive) =>
        key.toLowerCase().includes(sensitive) && !["checkKeys"].includes(key)
    );
    const secured = new Set([...SENSITIVE_KEYS, ...OMITTED_KEYS]);
    if (maybeSensitive && !secured.has(key))
      throw new Error(
        `Config key "${key}" may be sensitive but is exposed. Add it to SENSITIVE_KEYS or OMITTED_KEYS.`
      );
  }

  await maybeInitializeFirebase();
}

/**
 * Config keys that are masked on the info page, but not hidden as their
 * presence may be relevant to the user due to privacy implications.
 */
export const SENSITIVE_KEYS: (keyof Config)[] = ["googleSheetsSpreadsheetId"];

/**
 * Config keys that are not displayed on the info page at all, generally because
 * they are not relevant to the user or can be inferred from other config.
 */
export const OMITTED_KEYS = [
  "port",
  "bindAddress",
  "logLevel",
  "openaiKey",
  "anthropicKey",
  "googleAIKey",
  "mistralAIKey",
  "awsCredentials",
  "azureCredentials",
  "proxyKey",
  "adminKey",
  "serviceInfoPassword",
  "rejectPhrases",
  "rejectMessage",
  "showTokenCosts",
  "promptLoggingFilePrefix",
  "googleSheetsKey",
  "firebaseKey",
  "firebaseRtdbUrl",
  "gatekeeperStore",
  "maxIpsPerUser",
  "blockedOrigins",
  "blockMessage",
  "blockRedirect",
  "allowNicknameChanges",
  "showRecentImages",
  "useInsecureCookies",
  "staticServiceInfo",
  "checkKeys",
  "allowedModelFamilies",
  "trustedProxies",
  "proxyEndpointRoute",
  "adminWhitelist",
  "ipBlacklist",
] satisfies (keyof Config)[];
type OmitKeys = (typeof OMITTED_KEYS)[number];

type Printable<T> = {
  [P in keyof T as Exclude<P, OmitKeys>]: T[P] extends object
    ? Printable<T[P]>
    : string;
};
type PublicConfig = Printable<Config>;

const getKeys = Object.keys as <T extends object>(obj: T) => Array<keyof T>;

export function listConfig(obj: Config = config) {
  const result: Record<string, unknown> = {};
  for (const key of getKeys(obj)) {
    const value = obj[key]?.toString() || "";

    const shouldMask = SENSITIVE_KEYS.includes(key);
    const shouldOmit =
      OMITTED_KEYS.includes(key as OmitKeys) ||
      value === "" ||
      value === "undefined";

    if (shouldOmit) {
      continue;
    }

    const validKey = key as keyof Printable<Config>;

    if (value && shouldMask) {
      result[validKey] = "********";
    } else {
      result[validKey] = value;
    }

    if (typeof obj[key] === "object" && !Array.isArray(obj[key])) {
      result[key] = listConfig(obj[key] as unknown as Config);
    }
  }
  return result as PublicConfig;
}

/**
 * Tries to get a config value from one or more environment variables (in
 * order), falling back to a default value if none are set.
 */
function getEnvWithDefault<T>(env: string | string[], defaultValue: T): T {
  const value = Array.isArray(env)
    ? env.map((e) => process.env[e]).find((v) => v !== undefined)
    : process.env[env];
  if (value === undefined) {
    return defaultValue;
  }
  try {
    if (
      [
        "OPENAI_KEY",
        "ANTHROPIC_KEY",
        "GOOGLE_AI_KEY",
        "AWS_CREDENTIALS",
        "AZURE_CREDENTIALS",
      ].includes(String(env))
    ) {
      return value as unknown as T;
    }

    // Intended to be used for comma-delimited lists
    if (Array.isArray(defaultValue)) {
      return value.split(",").map((v) => v.trim()) as T;
    }

    return JSON.parse(value) as T;
  } catch (err) {
    return value as unknown as T;
  }
}

let firebaseApp: firebase.app.App | undefined;

async function maybeInitializeFirebase() {
  if (!config.gatekeeperStore.startsWith("firebase")) {
    return;
  }

  const firebase = await import("firebase-admin");
  const firebaseKey = Buffer.from(config.firebaseKey!, "base64").toString();
  const app = firebase.initializeApp({
    credential: firebase.credential.cert(JSON.parse(firebaseKey)),
    databaseURL: config.firebaseRtdbUrl,
  });

  await app.database().ref("connection-test").set(Date.now());

  firebaseApp = app;
}

export function getFirebaseApp(): firebase.app.App {
  if (!firebaseApp) {
    throw new Error("Firebase app not initialized.");
  }
  return firebaseApp;
}

function parseCsv(val: string): string[] {
  if (!val) return [];

  const regex = /(".*?"|[^",]+)(?=\s*,|\s*$)/g;
  const matches = val.match(regex) || [];
  return matches.map((item) => item.replace(/^"|"$/g, "").trim());
}
