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

// Model	Resolution	Price
// DALL·E 3	1024×1024	$0.040 / image
// 1024×1792, 1792×1024	$0.080 / image
// DALL·E 3 HD	1024×1024	$0.080 / image
// 1024×1792, 1792×1024	$0.120 / image
// DALL·E 2	1024×1024	$0.020 / image
// 512×512	$0.018 / image
// 256×256	$0.016 / image

export const DALLE_TOKENS_PER_DOLLAR = 100000;

/**
 * OpenAI image generation with DALL-E doesn't use tokens but everything else
 * in the application does. There is a fixed cost for each image generation
 * request depending on the model and selected quality/resolution parameters,
 * which we convert to tokens at a rate of 100000 tokens per dollar.
 */
export function getOpenAIImageCost(params: {
  model: "dall-e-2" | "dall-e-3";
  quality: "standard" | "hd";
  resolution: "512x512" | "256x256" | "1024x1024" | "1024x1792" | "1792x1024";
  n: number | null;
}) {
  const { model, quality, resolution, n } = params;
  const usd = (() => {
    switch (model) {
      case "dall-e-2":
        switch (resolution) {
          case "512x512":
            return 0.018;
          case "256x256":
            return 0.016;
          case "1024x1024":
            return 0.02;
          default:
            throw new Error("Invalid resolution");
        }
      case "dall-e-3":
        switch (resolution) {
          case "1024x1024":
            return quality === "standard" ? 0.04 : 0.08;
          case "1024x1792":
          case "1792x1024":
            return quality === "standard" ? 0.08 : 0.12;
          default:
            throw new Error("Invalid resolution");
        }
      default:
        throw new Error("Invalid image generation model");
    }
  })();

  const tokens = (n ?? 1) * (usd * DALLE_TOKENS_PER_DOLLAR);

  return {
    tokenizer: `openai-image cost`,
    token_count: Math.ceil(tokens),
  };
}
