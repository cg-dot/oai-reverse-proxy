import { APIFormat } from "../../../../shared/key-management";
import { assertNever } from "../../../../shared/utils";
import {
  mergeEventsForAnthropic,
  mergeEventsForOpenAIChat,
  mergeEventsForOpenAIText,
  OpenAIChatCompletionStreamEvent,
} from "./index";

/**
 * Collects SSE events containing incremental chat completion responses and
 * compiles them into a single finalized response for downstream middleware.
 */
export class EventAggregator {
  private readonly format: APIFormat;
  private readonly events: OpenAIChatCompletionStreamEvent[];

  constructor({ format }: { format: APIFormat }) {
    this.events = [];
    this.format = format;
  }

  addEvent(event: OpenAIChatCompletionStreamEvent) {
    this.events.push(event);
  }

  getFinalResponse() {
    switch (this.format) {
      case "openai":
      case "google-ai":
      case "mistral-ai":
        return mergeEventsForOpenAIChat(this.events);
      case "openai-text":
        return mergeEventsForOpenAIText(this.events);
      case "anthropic":
        return mergeEventsForAnthropic(this.events);
      case "openai-image":
        throw new Error(`SSE aggregation not supported for ${this.format}`);
      default:
        assertNever(this.format);
    }
  }
}
