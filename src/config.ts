import dotenv from "dotenv";
dotenv.config();

const isDev = process.env.NODE_ENV !== "production";

type PromptLoggingBackend = "google_sheets";
export type DequeueMode = "fair" | "random" | "none";

type Config = {
  /** The port the proxy server will listen on. */
  port: number;
  /** OpenAI API key, either a single key or a comma-delimeted list of keys. */
  openaiKey?: string;
  /**
   * The proxy key to require for requests. Only applicable if the user
   * management mode is set to 'proxy_key', and required if so.
   **/
  proxyKey?: string;
  /**
   * The admin key to used for accessing the /admin API. Required if the user
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
  /** Per-IP limit for requests per minute to OpenAI's completions endpoint. */
  modelRateLimit: number;
  /** Max number of tokens to generate. Requests which specify a higher value will be rewritten to use this value. */
  maxOutputTokens: number;
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
   * `none` - Hide quota information
   *
   * `partial` - Display quota information only as a percentage
   *
   * `full` - Display quota information as usage against total capacity
   */
  quotaDisplayMode: "none" | "partial" | "full";
  /**
   * Which request queueing strategy to use when keys are over their rate limit.
   *
   * `fair` - Requests are serviced in the order they were received (default)
   *
   * `random` - Requests are serviced randomly
   *
   * `none` - Requests are not queued and users have to retry manually
   */
  queueMode: DequeueMode;
};

// To change configs, create a file called .env in the root directory.
// See .env.example for an example.
export const config: Config = {
  port: getEnvWithDefault("PORT", 7860),
  openaiKey: getEnvWithDefault("OPENAI_KEY", ""),
  proxyKey: getEnvWithDefault("PROXY_KEY", ""),
  adminKey: getEnvWithDefault("ADMIN_KEY", ""),
  gatekeeper: getEnvWithDefault("GATEKEEPER", "none"),
  modelRateLimit: getEnvWithDefault("MODEL_RATE_LIMIT", 4),
  maxOutputTokens: getEnvWithDefault("MAX_OUTPUT_TOKENS", 300),
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
} as const;

/** Prevents the server from starting if config state is invalid. */
export function assertConfigIsValid(): void {
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
}

/** Masked, but not omitted as users may wish to see if they're set. */
export const SENSITIVE_KEYS: (keyof Config)[] = [
  "googleSheetsKey",
  "googleSheetsSpreadsheetId",
];

/** Omitted as they're not useful to display, masked or not. */
export const OMITTED_KEYS: (keyof Config)[] = [
  "port",
  "logLevel",
  "openaiKey",
  "proxyKey",
  "adminKey",
];

const getKeys = Object.keys as <T extends object>(obj: T) => Array<keyof T>;
export function listConfig(): Record<string, string> {
  const result: Record<string, string> = {};
  for (const key of getKeys(config)) {
    const value = config[key]?.toString() || "";

    if (value === "" || value === "undefined" || OMITTED_KEYS.includes(key)) {
      continue;
    }

    if (value && SENSITIVE_KEYS.includes(key)) {
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
    if (name === "OPENAI_KEY") {
      return value as unknown as T;
    }
    return JSON.parse(value) as T;
  } catch (err) {
    return value as unknown as T;
  }
}
