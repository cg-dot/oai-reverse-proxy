import { countTokens } from "@anthropic-ai/tokenizer";

export function init() {
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
    token_count: countTokens(prompt),
  };
}
