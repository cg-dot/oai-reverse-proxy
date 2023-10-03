import {
  OpenAIChatCompletionStreamEvent,
  SSEResponseTransformArgs,
} from "../index";
import { parseEvent, ServerSentEvent } from "../parse-sse";
import { logger } from "../../../../../logger";

const log = logger.child({
  module: "sse-transformer",
  transformer: "openai-to-openai",
});

export const passthroughToOpenAI = (params: SSEResponseTransformArgs) => {
  const { data } = params;

  const rawEvent = parseEvent(data);
  if (!rawEvent.data || rawEvent.data === "[DONE]") {
    return { position: -1 };
  }

  const completionEvent = asCompletion(rawEvent);
  if (!completionEvent) {
    return { position: -1 };
  }

  return { position: -1, event: completionEvent };
};

function asCompletion(
  event: ServerSentEvent
): OpenAIChatCompletionStreamEvent | null {
  try {
    return JSON.parse(event.data);
  } catch (error) {
    log.warn({ error: error.stack, event }, "Received invalid event");
  }
  return null;
}
