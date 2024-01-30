import { z } from "zod";
import { APIFormat } from "../key-management";
import { AnthropicV1CompleteSchema } from "./anthropic";
import { OpenAIV1ChatCompletionSchema } from "./openai";
import { OpenAIV1TextCompletionSchema } from "./openai-text";
import { OpenAIV1ImagesGenerationSchema } from "./openai-image";
import { GoogleAIV1GenerateContentSchema } from "./google-ai";
import { MistralAIV1ChatCompletionsSchema } from "./mistral-ai";

export { OpenAIChatMessage } from "./openai";
export { GoogleAIChatMessage } from "./google-ai";
export { MistralAIChatMessage } from "./mistral-ai";

export const API_SCHEMA_VALIDATORS: Record<APIFormat, z.ZodSchema<any>> = {
  anthropic: AnthropicV1CompleteSchema,
  openai: OpenAIV1ChatCompletionSchema,
  "openai-text": OpenAIV1TextCompletionSchema,
  "openai-image": OpenAIV1ImagesGenerationSchema,
  "google-ai": GoogleAIV1GenerateContentSchema,
  "mistral-ai": MistralAIV1ChatCompletionsSchema,
};
