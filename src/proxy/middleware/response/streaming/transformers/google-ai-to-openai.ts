import { StreamingCompletionTransformer } from "../index";
import { parseEvent, ServerSentEvent } from "../parse-sse";
import { logger } from "../../../../../logger";

const log = logger.child({
  module: "sse-transformer",
  transformer: "google-ai-to-openai",
});

type GoogleAIStreamEvent = {
  candidates: {
    content: { parts: { text: string }[]; role: string };
    finishReason?: "STOP" | "MAX_TOKENS" | "SAFETY" | "RECITATION" | "OTHER";
    index: number;
    tokenCount?: number;
    safetyRatings: { category: string; probability: string }[];
  }[];
};

/**
 * Transforms an incoming Google AI SSE to an equivalent OpenAI
 * chat.completion.chunk SSE.
 */
export const googleAIToOpenAI: StreamingCompletionTransformer = (params) => {
  const { data } = params;

  const rawEvent = parseEvent(data);
  if (!rawEvent.data || rawEvent.data === "[DONE]") {
    return { position: -1 };
  }

  const completionEvent = asCompletion(rawEvent);
  if (!completionEvent) {
    return { position: -1 };
  }

  const parts = completionEvent.candidates[0].content.parts;
  const text = parts[0]?.text ?? "";
  const newEvent = {
    id: "goo-" + params.fallbackId,
    object: "chat.completion.chunk" as const,
    created: Date.now(),
    model: params.fallbackModel,
    choices: [
      {
        index: 0,
        delta: { content: text },
        finish_reason: completionEvent.candidates[0].finishReason ?? null,
      },
    ],
  };

  return { position: -1, event: newEvent };
};

function asCompletion(event: ServerSentEvent): GoogleAIStreamEvent | null {
  try {
    const parsed = JSON.parse(event.data) as GoogleAIStreamEvent;
    if (parsed.candidates?.length > 0) {
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
