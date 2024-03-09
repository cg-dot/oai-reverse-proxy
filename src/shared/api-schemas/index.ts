import type { Request } from "express";
import { z } from "zod";
import { APIFormat } from "../key-management";
import {
  AnthropicV1TextSchema,
  AnthropicV1MessagesSchema,
  transformAnthropicTextToAnthropicChat,
  transformOpenAIToAnthropicText,
  transformOpenAIToAnthropicChat,
} from "./anthropic";
import { OpenAIV1ChatCompletionSchema } from "./openai";
import {
  OpenAIV1TextCompletionSchema,
  transformOpenAIToOpenAIText,
} from "./openai-text";
import {
  OpenAIV1ImagesGenerationSchema,
  transformOpenAIToOpenAIImage,
} from "./openai-image";
import {
  GoogleAIV1GenerateContentSchema,
  transformOpenAIToGoogleAI,
} from "./google-ai";
import { MistralAIV1ChatCompletionsSchema } from "./mistral-ai";

export { OpenAIChatMessage } from "./openai";
export {
  AnthropicChatMessage,
  AnthropicV1TextSchema,
  AnthropicV1MessagesSchema,
  flattenAnthropicMessages,
} from "./anthropic";
export { GoogleAIChatMessage } from "./google-ai";
export { MistralAIChatMessage } from "./mistral-ai";

type APIPair = `${APIFormat}->${APIFormat}`;
type TransformerMap = {
  [key in APIPair]?: APIFormatTransformer<any>;
};

export type APIFormatTransformer<Z extends z.ZodType<any, any>> = (
  req: Request
) => Promise<z.infer<Z>>;

export const API_REQUEST_TRANSFORMERS: TransformerMap = {
  "anthropic-text->anthropic-chat": transformAnthropicTextToAnthropicChat,
  "openai->anthropic-chat": transformOpenAIToAnthropicChat,
  "openai->anthropic-text": transformOpenAIToAnthropicText,
  "openai->openai-text": transformOpenAIToOpenAIText,
  "openai->openai-image": transformOpenAIToOpenAIImage,
  "openai->google-ai": transformOpenAIToGoogleAI,
};

export const API_REQUEST_VALIDATORS: Record<APIFormat, z.ZodSchema<any>> = {
  "anthropic-chat": AnthropicV1MessagesSchema,
  "anthropic-text": AnthropicV1TextSchema,
  openai: OpenAIV1ChatCompletionSchema,
  "openai-text": OpenAIV1TextCompletionSchema,
  "openai-image": OpenAIV1ImagesGenerationSchema,
  "google-ai": GoogleAIV1GenerateContentSchema,
  "mistral-ai": MistralAIV1ChatCompletionsSchema,
};
