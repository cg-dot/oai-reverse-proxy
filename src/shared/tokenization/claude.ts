import { getTokenizer } from "@anthropic-ai/tokenizer";
import { Tiktoken } from "tiktoken/lite";
import { AnthropicChatMessage } from "../api-schemas";
import { libSharp } from "../file-storage";
import { logger } from "../../logger";

const log = logger.child({ module: "tokenizer", service: "anthropic" });

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

export async function getTokenCount(
  prompt: string | { system: string; messages: AnthropicChatMessage[] }
) {
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

async function getTokenCountForMessages({
  system,
  messages,
}: {
  system: string;
  messages: AnthropicChatMessage[];
}) {
  let numTokens = 0;

  numTokens += (await getTokenCount(system)).token_count;

  for (const message of messages) {
    const { content, role } = message;
    numTokens += role === "user" ? userRoleCount : assistantRoleCount;

    const parts = Array.isArray(content)
      ? content
      : [{ type: "text" as const, text: content }];

    for (const part of parts) {
      switch (part.type) {
        case "text":
          const { text } = part;
          if (text.length > 800000 || numTokens > 200000) {
            throw new Error("Text content is too large to tokenize.");
          }
          numTokens += encoder.encode(text.normalize("NFKC"), "all").length;
          break;
        case "image":
          numTokens += await getImageTokenCount(part.source.data);
          break;
        default:
          throw new Error(`Unsupported Anthropic content type.`);
      }
    }
  }

  if (messages[messages.length - 1].role !== "assistant") {
    numTokens += assistantRoleCount;
  }

  return { tokenizer: "@anthropic-ai/tokenizer", token_count: numTokens };
}

async function getImageTokenCount(b64: string) {
  // https://docs.anthropic.com/claude/docs/vision
  // If your image's long edge is more than 1568 pixels, or your image is more
  // than ~1600 tokens, it will first be scaled down, preserving aspect ratio,
  // until it is within size limits. Assuming your image does not need to be
  // resized, you can estimate the number of tokens used via this simple
  // algorithm:
  // tokens = (width px * height px)/750

  const buffer = Buffer.from(b64, "base64");
  const image = libSharp(buffer);
  const metadata = await image.metadata();

  if (!metadata || !metadata.width || !metadata.height) {
    throw new Error("Prompt includes an image that could not be parsed");
  }

  const MAX_TOKENS = 1600;
  const MAX_LENGTH_PX = 1568;
  const PIXELS_PER_TOKEN = 750;
  const { width, height } = metadata;
  let tokens = (width * height) / PIXELS_PER_TOKEN;

  // Resize the image if it's too large
  if (tokens > MAX_TOKENS || width > MAX_LENGTH_PX || height > MAX_LENGTH_PX) {
    const longestEdge = Math.max(width, height);

    let factor;
    if (tokens > MAX_TOKENS) {
      const targetPixels = PIXELS_PER_TOKEN * MAX_TOKENS;
      factor = Math.sqrt(targetPixels / (width * height));
    } else {
      factor = MAX_LENGTH_PX / longestEdge;
    }

    const scaledWidth = width * factor;
    const scaledHeight = height * factor;

    tokens = (scaledWidth * scaledHeight) / 750;
  }

  log.debug({ width, height, tokens }, "Calculated Claude Vision token cost");
  return Math.ceil(tokens);
}
