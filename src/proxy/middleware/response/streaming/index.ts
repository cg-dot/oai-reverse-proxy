export type SSEResponseTransformArgs<S = Record<string, any>> = {
  data: string;
  lastPosition: number;
  index: number;
  fallbackId: string;
  fallbackModel: string;
  state?: S;
};

export type AnthropicV2StreamEvent = {
  log_id?: string;
  model?: string;
  completion: string;
  stop_reason: string | null;
};

export type OpenAIChatCompletionStreamEvent = {
  id: string;
  object: "chat.completion.chunk";
  created: number;
  model: string;
  choices: {
    index: number;
    delta: { role?: string; content?: string };
    finish_reason: string | null;
  }[];
};

export type StreamingCompletionTransformer<
  T = OpenAIChatCompletionStreamEvent,
  S = any,
> = (params: SSEResponseTransformArgs<S>) => {
  position: number;
  event?: T;
  state?: S;
};

export { openAITextToOpenAIChat } from "./transformers/openai-text-to-openai";
export { anthropicV1ToOpenAI } from "./transformers/anthropic-v1-to-openai";
export { anthropicV2ToOpenAI } from "./transformers/anthropic-v2-to-openai";
export { anthropicChatToAnthropicV2 } from "./transformers/anthropic-chat-to-anthropic-v2";
export { googleAIToOpenAI } from "./transformers/google-ai-to-openai";
export { passthroughToOpenAI } from "./transformers/passthrough-to-openai";
export { mergeEventsForOpenAIChat } from "./aggregators/openai-chat";
export { mergeEventsForOpenAIText } from "./aggregators/openai-text";
export { mergeEventsForAnthropicText } from "./aggregators/anthropic-text";
export { mergeEventsForAnthropicChat } from "./aggregators/anthropic-chat";
