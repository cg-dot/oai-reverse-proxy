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

// Tested against:
// https://github.com/openai/openai-cookbook/blob/main/examples/How_to_count_tokens_with_tiktoken.ipynb

export function getTokenCount(
  prompt: string | OpenAIPromptMessage[],
  model: string
) {
  if (typeof prompt === "string") {
    return getTextTokenCount(prompt);
  }

  const gpt4 = model.startsWith("gpt-4");

  const tokensPerMessage = gpt4 ? 3 : 4;
  const tokensPerName = gpt4 ? 1 : -1; // turbo omits role if name is present

  let numTokens = 0;

  for (const message of prompt) {
    numTokens += tokensPerMessage;
    for (const key of Object.keys(message)) {
      {
        const value = message[key as keyof OpenAIPromptMessage];
        if (!value || typeof value !== "string") continue;
        // Break if we get a huge message or exceed the token limit to prevent
        // DoS.
        // 100k tokens allows for future 100k GPT-4 models and 500k characters
        // is just a sanity check
        if (value.length > 500000 || numTokens > 100000) {
          numTokens = 100000;
          return {
            tokenizer: "tiktoken (prompt length limit exceeded)",
            token_count: numTokens,
          };
        }

        numTokens += encoder.encode(value).length;
        if (key === "name") {
          numTokens += tokensPerName;
        }
      }
    }
  }
  numTokens += 3; // every reply is primed with <|start|>assistant<|message|>
  return { tokenizer: "tiktoken", token_count: numTokens };
}

function getTextTokenCount(prompt: string) {
  if (prompt.length > 500000) {
    return {
      tokenizer: "length fallback",
      token_count: 100000,
    };
  }

  return {
    tokenizer: "tiktoken",
    token_count: encoder.encode(prompt).length,
  };
}

export type OpenAIPromptMessage = {
  name?: string;
  content: string;
  role: string;
};
