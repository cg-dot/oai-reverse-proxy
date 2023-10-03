import { StreamingCompletionTransformer } from "../index";
import { parseEvent, ServerSentEvent } from "../parse-sse";
import { logger } from "../../../../../logger";

const log = logger.child({
  module: "sse-transformer",
  transformer: "anthropic-v1-to-openai",
});

type AnthropicV1StreamEvent = {
  log_id?: string;
  model?: string;
  completion: string;
  stop_reason: string;
};

/**
 * Transforms an incoming Anthropic SSE (2023-01-01 API) to an equivalent
 * OpenAI chat.completion.chunk SSE.
 */
export const anthropicV1ToOpenAI: StreamingCompletionTransformer = (params) => {
  const { data, lastPosition } = params;

  const rawEvent = parseEvent(data);
  if (!rawEvent.data || rawEvent.data === "[DONE]") {
    return { position: lastPosition };
  }

  const completionEvent = asCompletion(rawEvent);
  if (!completionEvent) {
    return { position: lastPosition };
  }

  // Anthropic sends the full completion so far with each event whereas OpenAI
  // only sends the delta. To make the SSE events compatible, we remove
  // everything before `lastPosition` from the completion.
  const newEvent = {
    id: "ant-" + (completionEvent.log_id ?? params.fallbackId),
    object: "chat.completion.chunk" as const,
    created: Date.now(),
    model: completionEvent.model ?? params.fallbackModel,
    choices: [
      {
        index: 0,
        delta: { content: completionEvent.completion?.slice(lastPosition) },
        finish_reason: completionEvent.stop_reason,
      },
    ],
  };

  return { position: completionEvent.completion.length, event: newEvent };
};

function asCompletion(event: ServerSentEvent): AnthropicV1StreamEvent | null {
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
