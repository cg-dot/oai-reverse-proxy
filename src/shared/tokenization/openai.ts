import { Tiktoken } from "tiktoken/lite";
import cl100k_base from "tiktoken/encoders/cl100k_base.json";
import { logger } from "../../logger";
import { libSharp } from "../file-storage";
import { GoogleAIChatMessage, OpenAIChatMessage } from "../api-schemas";

const log = logger.child({ module: "tokenizer", service: "openai" });
const GPT4_VISION_SYSTEM_PROMPT_SIZE = 170;

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

export async function getTokenCount(
  prompt: string | OpenAIChatMessage[],
  model: string
) {
  if (typeof prompt === "string") {
    return getTextTokenCount(prompt);
  }

  const oldFormatting = model.startsWith("turbo-0301");
  const vision = model.includes("vision");

  const tokensPerMessage = oldFormatting ? 4 : 3;
  const tokensPerName = oldFormatting ? -1 : 1; // older formatting replaces role with name if name is present

  let numTokens = vision ? GPT4_VISION_SYSTEM_PROMPT_SIZE : 0;

  for (const message of prompt) {
    numTokens += tokensPerMessage;
    for (const key of Object.keys(message)) {
      {
        let textContent: string = "";
        const value = message[key as keyof OpenAIChatMessage];

        if (!value) continue;

        if (Array.isArray(value)) {
          for (const item of value) {
            if (item.type === "text") {
              textContent += item.text;
            } else if (["image", "image_url"].includes(item.type)) {
              const { url, detail } = item.image_url;
              const cost = await getGpt4VisionTokenCost(url, detail);
              numTokens += cost ?? 0;
            }
          }
        } else {
          textContent = value;
        }

        if (textContent.length > 800000 || numTokens > 200000) {
          throw new Error("Content is too large to tokenize.");
        }

        numTokens += encoder.encode(textContent).length;
        if (key === "name") {
          numTokens += tokensPerName;
        }
      }
    }
  }
  numTokens += 3; // every reply is primed with <|start|>assistant<|message|>
  return { tokenizer: "tiktoken", token_count: numTokens };
}

async function getGpt4VisionTokenCost(
  url: string,
  detail: "auto" | "low" | "high" = "auto"
) {
  // For now we do not allow remote images as the proxy would have to download
  // them, which is a potential DoS vector.
  if (!url.startsWith("data:image/")) {
    throw new Error(
      "Remote images are not supported. Add the image to your prompt as a base64 data URL."
    );
  }

  const base64Data = url.split(",")[1];
  const buffer = Buffer.from(base64Data, "base64");
  const image = libSharp(buffer);
  const metadata = await image.metadata();

  if (!metadata || !metadata.width || !metadata.height) {
    throw new Error("Prompt includes an image that could not be parsed");
  }

  const { width, height } = metadata;

  let selectedDetail: "low" | "high";
  if (detail === "auto") {
    const threshold = 512 * 512;
    const imageSize = width * height;
    selectedDetail = imageSize > threshold ? "high" : "low";
  } else {
    selectedDetail = detail;
  }

  // https://platform.openai.com/docs/guides/vision/calculating-costs
  if (selectedDetail === "low") {
    log.info(
      { width, height, tokens: 85 },
      "Using fixed GPT-4-Vision token cost for low detail image"
    );
    return 85;
  }

  let newWidth = width;
  let newHeight = height;
  if (width > 2048 || height > 2048) {
    const aspectRatio = width / height;
    if (width > height) {
      newWidth = 2048;
      newHeight = Math.round(2048 / aspectRatio);
    } else {
      newHeight = 2048;
      newWidth = Math.round(2048 * aspectRatio);
    }
  }

  if (newWidth < newHeight) {
    newHeight = Math.round((newHeight / newWidth) * 768);
    newWidth = 768;
  } else {
    newWidth = Math.round((newWidth / newHeight) * 768);
    newHeight = 768;
  }

  const tiles = Math.ceil(newWidth / 512) * Math.ceil(newHeight / 512);
  const tokens = 170 * tiles + 85;

  log.info(
    { width, height, newWidth, newHeight, tiles, tokens },
    "Calculated GPT-4-Vision token cost for high detail image"
  );
  return tokens;
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

export function estimateGoogleAITokenCount(
  prompt: string | GoogleAIChatMessage[]
) {
  if (typeof prompt === "string") {
    return getTextTokenCount(prompt);
  }

  const tokensPerMessage = 3;

  let numTokens = 0;
  for (const message of prompt) {
    numTokens += tokensPerMessage;
    numTokens += encoder.encode(message.parts[0].text).length;
  }

  numTokens += 3;

  return {
    tokenizer: "tiktoken (google-ai estimate)",
    token_count: numTokens,
  };
}
