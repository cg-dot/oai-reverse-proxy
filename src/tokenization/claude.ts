// For now this is just using the GPT vocabulary, even though Claude has a
// different one. Token counts won't be perfect so this just provides
// a rough estimate.
//
// TODO: use huggingface tokenizers instead of openai's tiktoken library since
// that should support the vocabulary file Anthropic provides.

import { Tiktoken } from "tiktoken/lite";
import cl100k_base from "tiktoken/encoders/cl100k_base.json";

let encoder: Tiktoken;

export function init() {
  encoder = new Tiktoken(
    cl100k_base.bpe_ranks,
    cl100k_base.special_tokens,
    cl100k_base.pat_str
  );
  return true;
}

export function getTokenCount(prompt: string, _model: string) {
  // Don't try tokenizing if the prompt is massive to prevent DoS.
  // 500k characters should be sufficient for all supported models.
  if (prompt.length > 500000) {
    return {
      tokenizer: "tiktoken (prompt length limit exceeded)",
      token_count: 100000,
    };
  }

  return {
    tokenizer: "tiktoken (cl100k_base)",
    token_count: encoder.encode(prompt).length,
  };
}
