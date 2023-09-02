import { getTokenizer } from "@anthropic-ai/tokenizer";
import { Tiktoken } from "tiktoken/lite";

let encoder: Tiktoken;

export function init() {
  // they export a `countTokens` function too but it instantiates a new
  // tokenizer every single time and it is not fast...
  encoder = getTokenizer();
  return true;
}

export function getTokenCount(prompt: string, _model: string) {
  // Don't try tokenizing if the prompt is massive to prevent DoS.
  // 500k characters should be sufficient for all supported models.
  if (prompt.length > 500000) {
    return {
      tokenizer: "length fallback",
      token_count: 100000,
    };
  }

  return {
    tokenizer: "@anthropic-ai/tokenizer",
    token_count: encoder.encode(prompt.normalize("NFKC"), "all").length,
  };
}
