import dotenv from "dotenv";
import type firebase from "firebase-admin";
import pino from "pino";
import type { ModelFamily } from "./shared/models";
dotenv.config();

const startupLogger = pino({ level: "debug" }).child({ module: "startup" });
const isDev = process.env.NODE_ENV !== "production";

type Config = {
  /** The port the proxy server will listen on. */
  port: number;
  /** Comma-delimited list of OpenAI API keys. */
  openaiKey?: string;
  /** Comma-delimited list of Anthropic API keys. */
  anthropicKey?: string;
  /** Comma-delimited list of Google PaLM API keys. */
  googlePalmKey?: string;
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
  /** Per-IP limit for requests per minute to OpenAI's completions endpoint. */
  modelRateLimit: number;
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
  /** Whether requests containing disallowed characters should be rejected. */
  rejectDisallowed?: boolean;
  /** Message to return when rejecting requests. */
  rejectMessage?: string;
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
  promptLoggingBackend?: "google_sheets";
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
  /**
   * If true, cookies will be set without the `Secure` attribute, allowing
   * the admin UI to used over HTTP.
   */
  useInsecureCookies: boolean;
};

// To change configs, create a file called .env in the root directory.
// See .env.example for an example.
export const config: Config = {
  port: getEnvWithDefault("PORT", 7860),
  openaiKey: getEnvWithDefault("OPENAI_KEY", ""),
  anthropicKey: getEnvWithDefault("ANTHROPIC_KEY", ""),
  googlePalmKey: getEnvWithDefault("GOOGLE_PALM_KEY", ""),
  awsCredentials: getEnvWithDefault("AWS_CREDENTIALS", ""),
  proxyKey: getEnvWithDefault("PROXY_KEY", ""),
  adminKey: getEnvWithDefault("ADMIN_KEY", ""),
  gatekeeper: getEnvWithDefault("GATEKEEPER", "none"),
  gatekeeperStore: getEnvWithDefault("GATEKEEPER_STORE", "memory"),
  maxIpsPerUser: getEnvWithDefault("MAX_IPS_PER_USER", 0),
  maxIpsAutoBan: getEnvWithDefault("MAX_IPS_AUTO_BAN", true),
  firebaseRtdbUrl: getEnvWithDefault("FIREBASE_RTDB_URL", undefined),
  firebaseKey: getEnvWithDefault("FIREBASE_KEY", undefined),
  modelRateLimit: getEnvWithDefault("MODEL_RATE_LIMIT", 4),
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
    "claude",
    "bison",
    "aws-claude",
  ]),
  rejectDisallowed: getEnvWithDefault("REJECT_DISALLOWED", false),
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
  tokenQuota: {
    turbo: getEnvWithDefault("TOKEN_QUOTA_TURBO", 0),
    gpt4: getEnvWithDefault("TOKEN_QUOTA_GPT4", 0),
    "gpt4-32k": getEnvWithDefault("TOKEN_QUOTA_GPT4_32K", 0),
    "gpt4-turbo": getEnvWithDefault("TOKEN_QUOTA_GPT4_TURBO", 0),
    claude: getEnvWithDefault("TOKEN_QUOTA_CLAUDE", 0),
    bison: getEnvWithDefault("TOKEN_QUOTA_BISON", 0),
    "aws-claude": getEnvWithDefault("TOKEN_QUOTA_AWS_CLAUDE", 0),
  },
  quotaRefreshPeriod: getEnvWithDefault("QUOTA_REFRESH_PERIOD", undefined),
  allowNicknameChanges: getEnvWithDefault("ALLOW_NICKNAME_CHANGES", true),
  useInsecureCookies: getEnvWithDefault("USE_INSECURE_COOKIES", isDev),
} as const;

function generateCookieSecret() {
  if (process.env.COOKIE_SECRET !== undefined) {
    return process.env.COOKIE_SECRET;
  }

  const seed = "" + config.adminKey + config.openaiKey + config.anthropicKey;
  const crypto = require("crypto");
  return crypto.createHash("sha256").update(seed).digest("hex");
}

export const COOKIE_SECRET = generateCookieSecret();

export async function assertConfigIsValid() {
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

  if (config.gatekeeper === "proxy_key" && !config.proxyKey) {
    throw new Error(
      "`proxy_key` gatekeeper mode requires a `PROXY_KEY` to be set."
    );
  }

  if (config.gatekeeper !== "proxy_key" && config.proxyKey) {
    throw new Error(
      "`PROXY_KEY` is set, but gatekeeper mode is not `proxy_key`. Make sure to set `GATEKEEPER=proxy_key`."
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
      (sensitive) => key.toLowerCase().includes(sensitive)
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
export const OMITTED_KEYS: (keyof Config)[] = [
  "port",
  "logLevel",
  "openaiKey",
  "anthropicKey",
  "googlePalmKey",
  "awsCredentials",
  "proxyKey",
  "adminKey",
  "checkKeys",
  "showTokenCosts",
  "googleSheetsKey",
  "firebaseKey",
  "firebaseRtdbUrl",
  "gatekeeperStore",
  "maxIpsPerUser",
  "blockedOrigins",
  "blockMessage",
  "blockRedirect",
  "allowNicknameChanges",
  "useInsecureCookies",
];

const getKeys = Object.keys as <T extends object>(obj: T) => Array<keyof T>;

export function listConfig(obj: Config = config): Record<string, any> {
  const result: Record<string, any> = {};
  for (const key of getKeys(obj)) {
    const value = obj[key]?.toString() || "";

    const shouldOmit =
      OMITTED_KEYS.includes(key) || value === "" || value === "undefined";
    const shouldMask = SENSITIVE_KEYS.includes(key);

    if (shouldOmit) {
      continue;
    }

    if (value && shouldMask) {
      result[key] = "********";
    } else {
      result[key] = value;
    }

    if (typeof obj[key] === "object" && !Array.isArray(obj[key])) {
      result[key] = listConfig(obj[key] as unknown as Config);
    }
  }
  return result;
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
        "GOOGLE_PALM_KEY",
        "AWS_CREDENTIALS",
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
