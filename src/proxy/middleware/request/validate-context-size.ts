import { Request } from "express";
import { z } from "zod";
import { config } from "../../../config";
import { assertNever } from "../../../shared/utils";
import { RequestPreprocessor } from ".";

const CLAUDE_MAX_CONTEXT = config.maxContextTokensAnthropic;
const OPENAI_MAX_CONTEXT = config.maxContextTokensOpenAI;
const BISON_MAX_CONTEXT = 8100;

/**
 * Assigns `req.promptTokens` and `req.outputTokens` based on the request body
 * and outbound API format, which combined determine the size of the context.
 * If the context is too large, an error is thrown.
 * This preprocessor should run after any preprocessor that transforms the
 * request body.
 */
export const validateContextSize: RequestPreprocessor = async (req) => {
  assertRequestHasTokenCounts(req);
  const promptTokens = req.promptTokens;
  const outputTokens = req.outputTokens;
  const contextTokens = promptTokens + outputTokens;
  const model = req.body.model;

  let proxyMax: number;
  switch (req.outboundApi) {
    case "openai":
    case "openai-text":
      proxyMax = OPENAI_MAX_CONTEXT;
      break;
    case "anthropic":
      proxyMax = CLAUDE_MAX_CONTEXT;
      break;
    case "google-palm":
      proxyMax = BISON_MAX_CONTEXT;
      break;
    case "openai-image":
      return;
    default:
      assertNever(req.outboundApi);
  }
  proxyMax ||= Number.MAX_SAFE_INTEGER;

  let modelMax: number;
  if (model.match(/gpt-3.5-turbo-16k/)) {
    modelMax = 16384;
  } else if (model.match(/gpt-4-1106(-preview)?/)) {
    modelMax = 131072;
  } else if (model.match(/gpt-3.5-turbo/)) {
    modelMax = 4096;
  } else if (model.match(/gpt-4-32k/)) {
    modelMax = 32768;
  } else if (model.match(/gpt-4/)) {
    modelMax = 8192;
  } else if (model.match(/^claude-(?:instant-)?v1(?:\.\d)?-100k/)) {
    modelMax = 100000;
  } else if (model.match(/^claude-(?:instant-)?v1(?:\.\d)?$/)) {
    modelMax = 9000;
  } else if (model.match(/^claude-2/)) {
    modelMax = 100000;
  } else if (model.match(/^text-bison-\d{3}$/)) {
    modelMax = BISON_MAX_CONTEXT;
  } else if (model.match(/^anthropic\.claude/)) {
    // Not sure if AWS Claude has the same context limit as Anthropic Claude.
    modelMax = 100000;
  } else {
    req.log.warn({ model }, "Unknown model, using 100k token limit.");
    modelMax = 100000;
  }

  const finalMax = Math.min(proxyMax, modelMax);
  z.object({
    tokens: z
      .number()
      .int()
      .max(finalMax, {
        message: `Your request exceeds the context size limit. (max: ${finalMax} tokens, requested: ${promptTokens} prompt + ${outputTokens} output = ${contextTokens} context tokens)`,
      }),
  }).parse({ tokens: contextTokens });

  req.log.debug(
    { promptTokens, outputTokens, contextTokens, modelMax, proxyMax },
    "Prompt size validated"
  );

  req.tokenizerInfo.prompt_tokens = promptTokens;
  req.tokenizerInfo.completion_tokens = outputTokens;
  req.tokenizerInfo.max_model_tokens = modelMax;
  req.tokenizerInfo.max_proxy_tokens = proxyMax;
};

function assertRequestHasTokenCounts(
  req: Request
): asserts req is Request & { promptTokens: number; outputTokens: number } {
  z.object({
    promptTokens: z.number().int().min(1),
    outputTokens: z.number().int().min(1),
  })
    .nonstrict()
    .parse({ promptTokens: req.promptTokens, outputTokens: req.outputTokens });
}
