import { Request } from "express";
import { assertNever } from "../utils";
import {
  getTokenCount as getClaudeTokenCount,
  init as initClaude,
} from "./claude";
import {
  estimateGoogleAITokenCount,
  getOpenAIImageCost,
  getTokenCount as getOpenAITokenCount,
  init as initOpenAi,
} from "./openai";
import {
  getTokenCount as getMistralAITokenCount,
  init as initMistralAI,
} from "./mistral";
import { APIFormat } from "../key-management";
import {
  GoogleAIChatMessage,
  MistralAIChatMessage,
  OpenAIChatMessage,
} from "../api-schemas";

export async function init() {
  initClaude();
  initOpenAi();
  initMistralAI();
}

/** Tagged union via `service` field of the different types of requests that can
 * be made to the tokenization service, for both prompts and completions */
type TokenCountRequest = { req: Request } & (
  | { prompt: OpenAIChatMessage[]; completion?: never; service: "openai" }
  | {
      prompt: string;
      completion?: never;
      service: "openai-text" | "anthropic" | "google-ai";
    }
  | { prompt?: GoogleAIChatMessage[]; completion?: never; service: "google-ai" }
  | {
      prompt: MistralAIChatMessage[];
      completion?: never;
      service: "mistral-ai";
    }
  | { prompt?: never; completion: string; service: APIFormat }
  | { prompt?: never; completion?: never; service: "openai-image" }
);

type TokenCountResult = {
  token_count: number;
  tokenizer: string;
  tokenization_duration_ms: number;
};

export async function countTokens({
  req,
  service,
  prompt,
  completion,
}: TokenCountRequest): Promise<TokenCountResult> {
  const time = process.hrtime();
  switch (service) {
    case "anthropic":
      return {
        ...getClaudeTokenCount(prompt ?? completion, req.body.model),
        tokenization_duration_ms: getElapsedMs(time),
      };
    case "openai":
    case "openai-text":
      return {
        ...(await getOpenAITokenCount(prompt ?? completion, req.body.model)),
        tokenization_duration_ms: getElapsedMs(time),
      };
    case "openai-image":
      return {
        ...getOpenAIImageCost({
          model: req.body.model,
          quality: req.body.quality,
          resolution: req.body.size,
          n: parseInt(req.body.n, 10) || null,
        }),
        tokenization_duration_ms: getElapsedMs(time),
      };
    case "google-ai":
      // TODO: Can't find a tokenization library for Gemini. There is an API
      // endpoint for it but it adds significant latency to the request.
      return {
        ...estimateGoogleAITokenCount(prompt ?? (completion || [])),
        tokenization_duration_ms: getElapsedMs(time),
      };
    case "mistral-ai":
      return {
        ...getMistralAITokenCount(prompt ?? completion),
        tokenization_duration_ms: getElapsedMs(time),
      };
    default:
      assertNever(service);
  }
}

function getElapsedMs(time: [number, number]) {
  const diff = process.hrtime(time);
  return diff[0] * 1000 + diff[1] / 1e6;
}
