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

export function getTokenCount(messages: any[], model: string) {
  const gpt4 = model.startsWith("gpt-4");

  const tokensPerMessage = gpt4 ? 3 : 4;
  const tokensPerName = gpt4 ? 1 : -1; // turbo omits role if name is present

  let numTokens = 0;

  for (const message of messages) {
    numTokens += tokensPerMessage;
    for (const key of Object.keys(message)) {
      {
        const value = message[key];
        // Break if we get a huge message or exceed the token limit to prevent DoS
        // 100k tokens allows for future 100k GPT-4 models and 250k characters is
        // just a sanity check
        if (value.length > 250000 || numTokens > 100000) {
          numTokens = 100000;
          return {
            tokenizer: "tiktoken (prompt length limit exceeded)",
            token_count: numTokens,
          };
        }

        numTokens += encoder.encode(message[key]).length;
        if (key === "name") {
          numTokens += tokensPerName;
        }
      }
    }
  }
  numTokens += 3; // every reply is primed with <|start|>assistant<|message|>
  return { tokenizer: "tiktoken", token_count: numTokens };
}

export type OpenAIPromptMessage = {
  name?: string;
  content: string;
  role: string;
};
