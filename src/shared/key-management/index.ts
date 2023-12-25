import type { LLMService, ModelFamily } from "../models";
import { OpenAIModel } from "./openai/provider";
import { AnthropicModel } from "./anthropic/provider";
import { GoogleAIModel } from "./google-ai/provider";
import { AwsBedrockModel } from "./aws/provider";
import { AzureOpenAIModel } from "./azure/provider";
import { KeyPool } from "./key-pool";

/** The request and response format used by a model's API. */
export type APIFormat =
  | "openai"
  | "anthropic"
  | "google-ai"
  | "mistral-ai"
  | "openai-text"
  | "openai-image";
export type Model =
  | OpenAIModel
  | AnthropicModel
  | GoogleAIModel
  | AwsBedrockModel
  | AzureOpenAIModel;

export interface Key {
  /** The API key itself. Never log this, use `hash` instead. */
  readonly key: string;
  /** The service that this key is for. */
  service: LLMService;
  /** The model families that this key has access to. */
  modelFamilies: ModelFamily[];
  /** Whether this key is currently disabled, meaning its quota has been exceeded or it has been revoked. */
  isDisabled: boolean;
  /** Whether this key specifically has been revoked. */
  isRevoked: boolean;
  /** The number of prompts that have been sent with this key. */
  promptCount: number;
  /** The time at which this key was last used. */
  lastUsed: number;
  /** The time at which this key was last checked. */
  lastChecked: number;
  /** Hash of the key, for logging and to find the key in the pool. */
  hash: string;
}

/*
KeyPool and KeyProvider's similarities are a relic of the old design where
there was only a single KeyPool for OpenAI keys. Now that there are multiple
supported services, the service-specific functionality has been moved to
KeyProvider and KeyPool is just a wrapper around multiple KeyProviders,
delegating to the appropriate one based on the model requested.

Existing code will continue to call methods on KeyPool, which routes them to
the appropriate KeyProvider or returns data aggregated across all KeyProviders
for service-agnostic functionality.
*/

export interface KeyProvider<T extends Key = Key> {
  readonly service: LLMService;
  init(): void;
  get(model: Model): T;
  list(): Omit<T, "key">[];
  disable(key: T): void;
  update(hash: string, update: Partial<T>): void;
  available(): number;
  incrementUsage(hash: string, model: string, tokens: number): void;
  getLockoutPeriod(model: ModelFamily): number;
  markRateLimited(hash: string): void;
  recheck(): void;
}

export const keyPool = new KeyPool();
export { AnthropicKey } from "./anthropic/provider";
export { OpenAIKey } from "./openai/provider";
export { GoogleAIKey } from "././google-ai/provider";
export { AwsBedrockKey } from "./aws/provider";
export { AzureOpenAIKey } from "./azure/provider";
