import { logger } from "../logger";

export type OpenAIModelFamily = "turbo" | "gpt4" | "gpt4-32k";
export type AnthropicModelFamily = "claude";
export type ModelFamily = OpenAIModelFamily | AnthropicModelFamily;
export type ModelFamilyMap = { [regex: string]: ModelFamily };

export const OPENAI_MODEL_FAMILY_MAP: { [regex: string]: OpenAIModelFamily } = {
  "^gpt-4-32k-\\d{4}$": "gpt4-32k",
  "^gpt-4-32k$": "gpt4-32k",
  "^gpt-4-\\d{4}$": "gpt4",
  "^gpt-4$": "gpt4",
  "^gpt-3.5-turbo": "turbo",
};

export function getOpenAIModelFamily(model: string): OpenAIModelFamily {
  for (const [regex, family] of Object.entries(OPENAI_MODEL_FAMILY_MAP)) {
    if (model.match(regex)) return family;
  }
  const stack = new Error().stack;
  logger.warn({ model, stack }, "Unmapped model family");
  return "gpt4";
}

export function getClaudeModelFamily(_model: string): ModelFamily {
  return "claude";
}
