import dotenv from "dotenv";
import type firebase from "firebase-admin";
import pino from "pino";
dotenv.config();

// Can't import the usual logger here because it itself needs the config.
const startupLogger = pino({ level: "debug" }).child({ module: "startup" });

const isDev = process.env.NODE_ENV !== "production";

type PromptLoggingBackend = "google_sheets";
export type DequeueMode = "fair" | "random" | "none";

type Config = {
  /** The port the proxy server will listen on. */
  port: number;
  /** Comma-delimited list of OpenAI API keys. */
  openaiKey?: string;
  /** Comma-delimited list of Anthropic API keys. */
  anthropicKey?: string;
  /**
   * The proxy key to require for requests. Only applicable if the user
   * management mode is set to 'proxy_key', and required if so.
   **/
  proxyKey?: string;
  /**
   * The admin key used to access the /admin API. Required if the user
   * management mode is set to 'user_token'.
   **/
  adminKey?: string;
  /**
   * Which user management mode to use.
   *
   * `none`: No user management. Proxy is open to all requests with basic
   *  abuse protection.
   *
   * `proxy_key`: A specific proxy key must be provided in the Authorization
   *  header to use the proxy.
   *
   * `user_token`: Users must be created via the /admin REST API and provide
   *  their personal access token in the Authorization header to use the proxy.
   *  Configure this function and add users via the /admin API.
   */
  gatekeeper: "none" | "proxy_key" | "user_token";
  /**
   * Persistence layer to use for user management.
   *
   * `memory`: Users are stored in memory and are lost on restart (default)
   *
   * `firebase_rtdb`: Users are stored in a Firebase Realtime Database; requires
   *  `firebaseKey` and `firebaseRtdbUrl` to be set.
   **/
  gatekeeperStore: "memory" | "firebase_rtdb";
  /** URL of the Firebase Realtime Database if using the Firebase RTDB store. */
  firebaseRtdbUrl?: string;
  /** Base64-encoded Firebase service account key if using the Firebase RTDB store. */
  firebaseKey?: string;
  /**
   * Maximum number of IPs per user, after which their token is disabled.
   * Users with the manually-assigned `special` role are exempt from this limit.
   * By default, this is 0, meaning that users are not IP-limited.
   */
  maxIpsPerUser: number;
  /** Per-IP limit for requests per minute to OpenAI's completions endpoint. */
  modelRateLimit: number;
  /** For OpenAI, the maximum number of sampled tokens a user can request. */
  maxOutputTokensOpenAI: number;
  /** For Anthropic, the maximum number of sampled tokens a user can request. */
  maxOutputTokensAnthropic: number;
  /** Whether requests containing disallowed characters should be rejected. */
  rejectDisallowed?: boolean;
  /** Message to return when rejecting requests. */
  rejectMessage?: string;
  /** Pino log level. */
  logLevel?: "debug" | "info" | "warn" | "error";
  /** Whether prompts and responses should be logged to persistent storage. */
  promptLogging?: boolean;
  /** Which prompt logging backend to use. */
  promptLoggingBackend?: PromptLoggingBackend;
  /** Base64-encoded Google Sheets API key. */
  googleSheetsKey?: string;
  /** Google Sheets spreadsheet ID. */
  googleSheetsSpreadsheetId?: string;
  /** Whether to periodically check keys for usage and validity. */
  checkKeys?: boolean;
  /**
   * How to display quota information on the info page.
   *
   * `none`: Hide quota information
   *
   * `partial`: Display quota information only as a percentage
   *
   * `full`: Display quota information as usage against total capacity
   */
  quotaDisplayMode: "none" | "partial" | "full";
  /**
   * Which request queueing strategy to use when keys are over their rate limit.
   *
   * `fair`: Requests are serviced in the order they were received (default)
   *
   * `random`: Requests are serviced randomly
   *
   * `none`: Requests are not queued and users have to retry manually
   */
  queueMode: DequeueMode;
  /**
   * Comma-separated list of origins to block. Requests matching any of these
   * origins or referers will be rejected.
   * Partial matches are allowed, so `reddit` will match `www.reddit.com`.
   * Include only the hostname, not the protocol or path, e.g:
   *  `reddit.com,9gag.com,gaiaonline.com`
   */
  blockedOrigins?: string;
  /**
   * Message to return when rejecting requests from blocked origins.
   */
  blockMessage?: string;
  /**
   * Desination URL to redirect blocked requests to, for non-JSON requests.
   */
  blockRedirect?: string;
  /**
   * Whether the proxy should disallow requests for GPT-4 models in order to
   * prevent excessive spend.  Applies only to OpenAI.
   */
  turboOnly?: boolean;
};

// To change configs, create a file called .env in the root directory.
// See .env.example for an example.
export const config: Config = {
  port: getEnvWithDefault("PORT", 7860),
  openaiKey: getEnvWithDefault("OPENAI_KEY", ""),
  anthropicKey: getEnvWithDefault("ANTHROPIC_KEY", ""),
  proxyKey: getEnvWithDefault("PROXY_KEY", ""),
  adminKey: getEnvWithDefault("ADMIN_KEY", ""),
  gatekeeper: getEnvWithDefault("GATEKEEPER", "none"),
  gatekeeperStore: getEnvWithDefault("GATEKEEPER_STORE", "memory"),
  maxIpsPerUser: getEnvWithDefault("MAX_IPS_PER_USER", 0),
  firebaseRtdbUrl: getEnvWithDefault("FIREBASE_RTDB_URL", undefined),
  firebaseKey: getEnvWithDefault("FIREBASE_KEY", undefined),
  modelRateLimit: getEnvWithDefault("MODEL_RATE_LIMIT", 4),
  maxOutputTokensOpenAI: getEnvWithDefault("MAX_OUTPUT_TOKENS_OPENAI", 300),
  maxOutputTokensAnthropic: getEnvWithDefault(
    "MAX_OUTPUT_TOKENS_ANTHROPIC",
    600
  ),
  rejectDisallowed: getEnvWithDefault("REJECT_DISALLOWED", false),
  rejectMessage: getEnvWithDefault(
    "REJECT_MESSAGE",
    "This content violates /aicg/'s acceptable use policy."
  ),
  logLevel: getEnvWithDefault("LOG_LEVEL", "info"),
  checkKeys: getEnvWithDefault("CHECK_KEYS", !isDev),
  quotaDisplayMode: getEnvWithDefault("QUOTA_DISPLAY_MODE", "partial"),
  promptLogging: getEnvWithDefault("PROMPT_LOGGING", false),
  promptLoggingBackend: getEnvWithDefault("PROMPT_LOGGING_BACKEND", undefined),
  googleSheetsKey: getEnvWithDefault("GOOGLE_SHEETS_KEY", undefined),
  googleSheetsSpreadsheetId: getEnvWithDefault(
    "GOOGLE_SHEETS_SPREADSHEET_ID",
    undefined
  ),
  queueMode: getEnvWithDefault("QUEUE_MODE", "fair"),
  blockedOrigins: getEnvWithDefault("BLOCKED_ORIGINS", undefined),
  blockMessage: getEnvWithDefault(
    "BLOCK_MESSAGE",
    "You must be over the age of majority in your country to use this service."
  ),
  blockRedirect: getEnvWithDefault("BLOCK_REDIRECT", "https://www.9gag.com"),
  turboOnly: getEnvWithDefault("TURBO_ONLY", false),
} as const;

function migrateConfigs() {
  let migrated = false;
  const deprecatedMax = process.env.MAX_OUTPUT_TOKENS;

  if (!process.env.MAX_OUTPUT_TOKENS_OPENAI && deprecatedMax) {
    migrated = true;
    config.maxOutputTokensOpenAI = parseInt(deprecatedMax);
  }
  if (!process.env.MAX_OUTPUT_TOKENS_ANTHROPIC && deprecatedMax) {
    migrated = true;
    config.maxOutputTokensAnthropic = parseInt(deprecatedMax);
  }

  if (migrated) {
    startupLogger.warn(
      {
        MAX_OUTPUT_TOKENS: deprecatedMax,
        MAX_OUTPUT_TOKENS_OPENAI: config.maxOutputTokensOpenAI,
        MAX_OUTPUT_TOKENS_ANTHROPIC: config.maxOutputTokensAnthropic,
      },
      "`MAX_OUTPUT_TOKENS` has been replaced with separate `MAX_OUTPUT_TOKENS_OPENAI` and `MAX_OUTPUT_TOKENS_ANTHROPIC` configs. You should update your .env file to remove `MAX_OUTPUT_TOKENS` and set the new configs."
    );
  }
}

/** Prevents the server from starting if config state is invalid. */
export async function assertConfigIsValid() {
  migrateConfigs();

  // Ensure gatekeeper mode is valid.
  if (!["none", "proxy_key", "user_token"].includes(config.gatekeeper)) {
    throw new Error(
      `Invalid gatekeeper mode: ${config.gatekeeper}. Must be one of: none, proxy_key, user_token.`
    );
  }

  // Don't allow `user_token` mode without `ADMIN_KEY`.
  if (config.gatekeeper === "user_token" && !config.adminKey) {
    throw new Error(
      "`user_token` gatekeeper mode requires an `ADMIN_KEY` to be set."
    );
  }

  // Don't allow `proxy_key` mode without `PROXY_KEY`.
  if (config.gatekeeper === "proxy_key" && !config.proxyKey) {
    throw new Error(
      "`proxy_key` gatekeeper mode requires a `PROXY_KEY` to be set."
    );
  }

  // Don't allow `PROXY_KEY` to be set for other modes.
  if (config.gatekeeper !== "proxy_key" && config.proxyKey) {
    throw new Error(
      "`PROXY_KEY` is set, but gatekeeper mode is not `proxy_key`. Make sure to set `GATEKEEPER=proxy_key`."
    );
  }

  // Require appropriate firebase config if using firebase store.
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
  "proxyKey",
  "adminKey",
  "checkKeys",
  "quotaDisplayMode",
  "googleSheetsKey",
  "firebaseKey",
  "firebaseRtdbUrl",
  "gatekeeperStore",
  "maxIpsPerUser",
  "blockedOrigins",
  "blockMessage",
  "blockRedirect",
];

const getKeys = Object.keys as <T extends object>(obj: T) => Array<keyof T>;

export function listConfig(): Record<string, string> {
  const result: Record<string, string> = {};
  for (const key of getKeys(config)) {
    const value = config[key]?.toString() || "";

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
  }
  return result;
}

function getEnvWithDefault<T>(name: string, defaultValue: T): T {
  const value = process.env[name];
  if (value === undefined) {
    return defaultValue;
  }
  try {
    if (name === "OPENAI_KEY" || name === "ANTHROPIC_KEY") {
      return value as unknown as T;
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
