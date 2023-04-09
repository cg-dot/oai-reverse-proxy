import dotenv from "dotenv";
dotenv.config();

type Config = {
  /** The port the proxy server will listen on. */
  port: number;
  /** OpenAI API key, either a single key or a base64-encoded JSON array of key configs. */
  openaiKey?: string;
  /** Proxy key. If set, requests must provide this key in the Authorization header to use the proxy. */
  proxyKey?: string;
  /** Per-IP limit for requests per minute to OpenAI's completions endpoint. */
  modelRateLimit: number;
  /** Max number of tokens to generate. Requests which specify a higher value will be rewritten to use this value. */
  maxOutputTokens: number;
  /** Whether requests containing disallowed characters should be rejected. */
  rejectDisallowed?: boolean;
  /** Message to return when rejecting requests. */
  rejectMessage?: string;
  /** Logging threshold. */
  logLevel?: "debug" | "info" | "warn" | "error";
  /** Whether prompts and responses should be logged. */
  logPrompts?: boolean; // TODO
};

export const config: Config = {
  port: getEnvWithDefault("PORT", 7860),
  openaiKey: getEnvWithDefault("OPENAI_KEY", ""),
  proxyKey: getEnvWithDefault("PROXY_KEY", ""),
  modelRateLimit: getEnvWithDefault("MODEL_RATE_LIMIT", 2),
  maxOutputTokens: getEnvWithDefault("MAX_OUTPUT_TOKENS", 256),
  rejectDisallowed: getEnvWithDefault("REJECT_DISALLOWED", false),
  rejectMessage: getEnvWithDefault(
    "REJECT_MESSAGE",
    "This content violates /aicg/'s acceptable use policy."
  ),
  logLevel: getEnvWithDefault("LOG_LEVEL", "info"),
  logPrompts: getEnvWithDefault("LOG_PROMPTS", false),
} as const;

export const SENSITIVE_KEYS: (keyof Config)[] = ["proxyKey", "openaiKey"];
const getKeys = Object.keys as <T extends object>(obj: T) => Array<keyof T>;
export function listConfig(): Record<string, string> {
  const result: Record<string, string> = {};
  for (const key of getKeys(config)) {
    const value = config[key]?.toString() || "";
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
