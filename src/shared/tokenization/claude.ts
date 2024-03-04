import { getTokenizer } from "@anthropic-ai/tokenizer";
import { Tiktoken } from "tiktoken/lite";
import { AnthropicChatMessage } from "../api-schemas";

let encoder: Tiktoken;
let userRoleCount = 0;
let assistantRoleCount = 0;

export function init() {
  // they export a `countTokens` function too but it instantiates a new
  // tokenizer every single time and it is not fast...
  encoder = getTokenizer();
  userRoleCount = encoder.encode("\n\nHuman: ", "all").length;
  assistantRoleCount = encoder.encode("\n\nAssistant: ", "all").length;
  return true;
}

export function getTokenCount(prompt: string | AnthropicChatMessage[]) {
  if (typeof prompt !== "string") {
    return getTokenCountForMessages(prompt);
  }

  if (prompt.length > 800000) {
    throw new Error("Content is too large to tokenize.");
  }

  return {
    tokenizer: "@anthropic-ai/tokenizer",
    token_count: encoder.encode(prompt.normalize("NFKC"), "all").length,
  };
}

function getTokenCountForMessages(messages: AnthropicChatMessage[]) {
  let numTokens = 0;

  for (const message of messages) {
    const { content, role } = message;
    numTokens += role === "user" ? userRoleCount : assistantRoleCount;

    const parts = Array.isArray(content)
      ? content
      : [{ type: "text", text: content }];

    for (const part of parts) {
      // We don't allow other content types for now because we can't estimate
      // cost for them.
      if (part.type !== "text") {
        throw new Error(`Unsupported Anthropic content type: ${part.type}`);
      }

      if (part.text.length > 800000 || numTokens > 200000) {
        throw new Error("Content is too large to tokenize.");
      }

      numTokens += encoder.encode(part.text.normalize("NFKC"), "all").length;
    }
  }

  if (messages[messages.length - 1].role !== "assistant") {
    numTokens += assistantRoleCount;
  }

  return { tokenizer: "@anthropic-ai/tokenizer", token_count: numTokens };
}
