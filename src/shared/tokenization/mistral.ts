import { MistralAIChatMessage } from "../../proxy/middleware/request/preprocessors/transform-outbound-payload";
import * as tokenizer from "./mistral-tokenizer-js";

export function init() {
  tokenizer.initializemistralTokenizer();
  return true;
}

export function getTokenCount(prompt: MistralAIChatMessage[] | string) {
  if (typeof prompt === "string") {
    return getTextTokenCount(prompt);
  }

  let chunks = [];
  for (const message of prompt) {
    switch (message.role) {
      case "system":
        chunks.push(message.content);
        break;
      case "assistant":
        chunks.push(message.content + "</s>");
        break;
      case "user":
        chunks.push("[INST] " + message.content + " [/INST]");
        break;
    }
  }
  return getTextTokenCount(chunks.join(" "));
}

function getTextTokenCount(prompt: string) {
  // Don't try tokenizing if the prompt is massive to prevent DoS.
  // 500k characters should be sufficient for all supported models.
  if (prompt.length > 500000) {
    return {
      tokenizer: "length fallback",
      token_count: 100000,
    };
  }

  return {
    tokenizer: "mistral-tokenizer-js",
    token_count: tokenizer.encode(prompt.normalize("NFKC"))!.length,
  };
}
