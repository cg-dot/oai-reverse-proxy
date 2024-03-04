import {
  AnthropicV2StreamEvent,
  StreamingCompletionTransformer,
} from "../index";
import { parseEvent, ServerSentEvent } from "../parse-sse";
import { logger } from "../../../../../logger";

const log = logger.child({
  module: "sse-transformer",
  transformer: "anthropic-v2-to-openai",
});

/**
 * Transforms an incoming Anthropic SSE (2023-06-01 API) to an equivalent
 * OpenAI chat.completion.chunk SSE.
 */
export const anthropicV2ToOpenAI: StreamingCompletionTransformer = (params) => {
  const { data } = params;

  const rawEvent = parseEvent(data);
  if (!rawEvent.data || rawEvent.data === "[DONE]") {
    return { position: -1 };
  }

  const completionEvent = asCompletion(rawEvent);
  if (!completionEvent) {
    return { position: -1 };
  }

  const newEvent = {
    id: "ant-" + (completionEvent.log_id ?? params.fallbackId),
    object: "chat.completion.chunk" as const,
    created: Date.now(),
    model: completionEvent.model ?? params.fallbackModel,
    choices: [
      {
        index: 0,
        delta: { content: completionEvent.completion },
        finish_reason: completionEvent.stop_reason,
      },
    ],
  };

  return { position: completionEvent.completion.length, event: newEvent };
};

function asCompletion(event: ServerSentEvent): AnthropicV2StreamEvent | null {
  if (event.type === "ping") return null;

  try {
    const parsed = JSON.parse(event.data);
    if (parsed.completion !== undefined && parsed.stop_reason !== undefined) {
      return parsed;
    } else {
      // noinspection ExceptionCaughtLocallyJS
      throw new Error("Missing required fields");
    }
  } catch (error) {
    log.warn({ error: error.stack, event }, "Received invalid event");
  }
  return null;
}
