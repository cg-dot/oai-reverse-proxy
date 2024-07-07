import { StreamingCompletionTransformer } from "../index";
import { parseEvent } from "../parse-sse";
import { logger } from "../../../../../logger";
import { asAnthropicChatDelta } from "./anthropic-chat-to-anthropic-v2";

const log = logger.child({
  module: "sse-transformer",
  transformer: "anthropic-chat-to-openai",
});

/**
 * Transforms an incoming Anthropic Chat SSE to an equivalent OpenAI
 * chat.completion.chunks SSE.
 */
export const anthropicChatToOpenAI: StreamingCompletionTransformer = (
  params
) => {
  const { data } = params;

  const rawEvent = parseEvent(data);
  if (!rawEvent.data || !rawEvent.type) {
    return { position: -1 };
  }

  const deltaEvent = asAnthropicChatDelta(rawEvent);
  if (!deltaEvent) {
    return { position: -1 };
  }

  const newEvent = {
    id: params.fallbackId,
    object: "chat.completion.chunk" as const,
    created: Date.now(),
    model: params.fallbackModel,
    choices: [
      {
        index: 0,
        delta: { content: deltaEvent.delta.text },
        finish_reason: null,
      },
    ],
  };

  return { position: -1, event: newEvent };
};
