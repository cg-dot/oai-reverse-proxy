// Don't import any other project files here as this is one of the first modules
// loaded and it will cause circular imports.

import pino from "pino";
import type { Request } from "express";

/**
 * The service that a model is hosted on. Distinct from `APIFormat` because some
 * services have interoperable APIs (eg Anthropic/AWS, OpenAI/Azure).
 */
export type LLMService =
  | "openai"
  | "anthropic"
  | "google-ai"
  | "mistral-ai"
  | "aws"
  | "azure";

export type OpenAIModelFamily =
  | "turbo"
  | "gpt4"
  | "gpt4-32k"
  | "gpt4-turbo"
  | "dall-e";
export type AnthropicModelFamily = "claude";
export type GoogleAIModelFamily = "gemini-pro";
export type MistralAIModelFamily =
  | "mistral-tiny"
  | "mistral-small"
  | "mistral-medium";
export type AwsBedrockModelFamily = "aws-claude";
export type AzureOpenAIModelFamily = `azure-${Exclude<
  OpenAIModelFamily,
  "dall-e"
>}`;
export type ModelFamily =
  | OpenAIModelFamily
  | AnthropicModelFamily
  | GoogleAIModelFamily
  | MistralAIModelFamily
  | AwsBedrockModelFamily
  | AzureOpenAIModelFamily;

export const MODEL_FAMILIES = (<A extends readonly ModelFamily[]>(
  arr: A & ([ModelFamily] extends [A[number]] ? unknown : never)
) => arr)([
  "turbo",
  "gpt4",
  "gpt4-32k",
  "gpt4-turbo",
  "dall-e",
  "claude",
  "gemini-pro",
  "mistral-tiny",
  "mistral-small",
  "mistral-medium",
  "aws-claude",
  "azure-turbo",
  "azure-gpt4",
  "azure-gpt4-32k",
  "azure-gpt4-turbo",
] as const);

export const LLM_SERVICES = (<A extends readonly LLMService[]>(
  arr: A & ([LLMService] extends [A[number]] ? unknown : never)
) => arr)([
  "openai",
  "anthropic",
  "google-ai",
  "mistral-ai",
  "aws",
  "azure",
] as const);

export const OPENAI_MODEL_FAMILY_MAP: { [regex: string]: OpenAIModelFamily } = {
  "^gpt-4-turbo(-preview)?$": "gpt4-turbo",
  "^gpt-4-(0125|1106)(-preview)?$": "gpt4-turbo",
  "^gpt-4(-\\d{4})?-vision(-preview)?$": "gpt4-turbo",
  "^gpt-4-32k-\\d{4}$": "gpt4-32k",
  "^gpt-4-32k$": "gpt4-32k",
  "^gpt-4-\\d{4}$": "gpt4",
  "^gpt-4$": "gpt4",
  "^gpt-3.5-turbo": "turbo",
  "^text-embedding-ada-002$": "turbo",
  "^dall-e-\\d{1}$": "dall-e",
};

export const MODEL_FAMILY_SERVICE: {
  [f in ModelFamily]: LLMService;
} = {
  turbo: "openai",
  gpt4: "openai",
  "gpt4-turbo": "openai",
  "gpt4-32k": "openai",
  "dall-e": "openai",
  claude: "anthropic",
  "aws-claude": "aws",
  "azure-turbo": "azure",
  "azure-gpt4": "azure",
  "azure-gpt4-32k": "azure",
  "azure-gpt4-turbo": "azure",
  "gemini-pro": "google-ai",
  "mistral-tiny": "mistral-ai",
  "mistral-small": "mistral-ai",
  "mistral-medium": "mistral-ai",
};

pino({ level: "debug" }).child({ module: "startup" });

export function getOpenAIModelFamily(
  model: string,
  defaultFamily: OpenAIModelFamily = "gpt4"
): OpenAIModelFamily {
  for (const [regex, family] of Object.entries(OPENAI_MODEL_FAMILY_MAP)) {
    if (model.match(regex)) return family;
  }
  return defaultFamily;
}

export function getClaudeModelFamily(model: string): ModelFamily {
  if (model.startsWith("anthropic.")) return getAwsBedrockModelFamily(model);
  return "claude";
}

export function getGoogleAIModelFamily(_model: string): ModelFamily {
  return "gemini-pro";
}

export function getMistralAIModelFamily(model: string): MistralAIModelFamily {
  switch (model) {
    case "mistral-tiny":
    case "mistral-small":
    case "mistral-medium":
      return model;
    default:
      return "mistral-tiny";
  }
}

export function getAwsBedrockModelFamily(_model: string): ModelFamily {
  return "aws-claude";
}

export function getAzureOpenAIModelFamily(
  model: string,
  defaultFamily: AzureOpenAIModelFamily = "azure-gpt4"
): AzureOpenAIModelFamily {
  // Azure model names omit periods.  addAzureKey also prepends "azure-" to the
  // model name to route the request the correct keyprovider, so we need to
  // remove that as well.
  const modified = model
    .replace("gpt-35-turbo", "gpt-3.5-turbo")
    .replace("azure-", "");
  for (const [regex, family] of Object.entries(OPENAI_MODEL_FAMILY_MAP)) {
    if (modified.match(regex)) {
      return `azure-${family}` as AzureOpenAIModelFamily;
    }
  }
  return defaultFamily;
}

export function assertIsKnownModelFamily(
  modelFamily: string
): asserts modelFamily is ModelFamily {
  if (!MODEL_FAMILIES.includes(modelFamily as ModelFamily)) {
    throw new Error(`Unknown model family: ${modelFamily}`);
  }
}

export function getModelFamilyForRequest(req: Request): ModelFamily {
  if (req.modelFamily) return req.modelFamily;
  // There is a single request queue, but it is partitioned by model family.
  // Model families are typically separated on cost/rate limit boundaries so
  // they should be treated as separate queues.
  const model = req.body.model ?? "gpt-3.5-turbo";
  let modelFamily: ModelFamily;

  // Weird special case for AWS/Azure because they serve multiple models from
  // different vendors, even if currently only one is supported.
  if (req.service === "aws") {
    modelFamily = getAwsBedrockModelFamily(model);
  } else if (req.service === "azure") {
    modelFamily = getAzureOpenAIModelFamily(model);
  } else {
    switch (req.outboundApi) {
      case "anthropic":
        modelFamily = getClaudeModelFamily(model);
        break;
      case "openai":
      case "openai-text":
      case "openai-image":
        modelFamily = getOpenAIModelFamily(model);
        break;
      case "google-ai":
        modelFamily = getGoogleAIModelFamily(model);
        break;
      case "mistral-ai":
        modelFamily = getMistralAIModelFamily(model);
        break;
      default:
        assertNever(req.outboundApi);
    }
  }

  return (req.modelFamily = modelFamily);
}

function assertNever(x: never): never {
  throw new Error(`Called assertNever with argument ${x}.`);
}
