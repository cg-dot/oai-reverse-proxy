import { OPENAI_SUPPORTED_MODELS, OpenAIModel } from "./openai/provider";
import {
  ANTHROPIC_SUPPORTED_MODELS,
  AnthropicModel,
} from "./anthropic/provider";
import { GOOGLE_PALM_SUPPORTED_MODELS, GooglePalmModel } from "./palm/provider";
import { AWS_BEDROCK_SUPPORTED_MODELS, AwsBedrockModel } from "./aws/provider";
import { KeyPool } from "./key-pool";
import type { ModelFamily } from "../models";

/** The request and response format used by a model's API. */
export type APIFormat = "openai" | "anthropic" | "google-palm" | "openai-text";
/** The service that a model is hosted on; distinct because services like AWS provide multiple APIs, but have their own endpoints and authentication. */
export type LLMService = "openai" | "anthropic" | "google-palm" | "aws";
export type Model =
  | OpenAIModel
  | AnthropicModel
  | GooglePalmModel
  | AwsBedrockModel;

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
  getLockoutPeriod(model: Model): number;
  markRateLimited(hash: string): void;
  recheck(): void;
}

export const keyPool = new KeyPool();
export const SUPPORTED_MODELS = [
  ...OPENAI_SUPPORTED_MODELS,
  ...ANTHROPIC_SUPPORTED_MODELS,
] as const;
export type SupportedModel = (typeof SUPPORTED_MODELS)[number];
export {
  OPENAI_SUPPORTED_MODELS,
  ANTHROPIC_SUPPORTED_MODELS,
  GOOGLE_PALM_SUPPORTED_MODELS,
  AWS_BEDROCK_SUPPORTED_MODELS,
};
export { AnthropicKey } from "./anthropic/provider";
export { OpenAIKey } from "./openai/provider";
export { GooglePalmKey } from "./palm/provider";
export { AwsBedrockKey } from "./aws/provider";