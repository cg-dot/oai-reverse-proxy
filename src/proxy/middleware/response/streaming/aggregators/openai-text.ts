import { OpenAIChatCompletionStreamEvent } from "../index";

export type OpenAiTextCompletionResponse = {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: {
    text: string;
    finish_reason: string | null;
    index: number;
    logprobs: null;
  }[];
};

/**
 * Given a list of OpenAI chat completion events, compiles them into a single
 * finalized OpenAI text completion response so that non-streaming middleware
 * can operate on it as if it were a blocking response.
 */
export function mergeEventsForOpenAIText(
  events: OpenAIChatCompletionStreamEvent[]
): OpenAiTextCompletionResponse {
  let merged: OpenAiTextCompletionResponse = {
    id: "",
    object: "",
    created: 0,
    model: "",
    choices: [],
  };
  merged = events.reduce((acc, event, i) => {
    // The first event will only contain role assignment and response metadata
    if (i === 0) {
      acc.id = event.id;
      acc.object = event.object;
      acc.created = event.created;
      acc.model = event.model;
      acc.choices = [
        {
          text: "",
          index: 0,
          finish_reason: null,
          logprobs: null,
        },
      ];
      return acc;
    }

    acc.choices[0].finish_reason = event.choices[0].finish_reason;
    if (event.choices[0].delta.content) {
      acc.choices[0].text += event.choices[0].delta.content;
    }

    return acc;
  }, merged);
  return merged;
}
