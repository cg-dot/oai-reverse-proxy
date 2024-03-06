import { z } from "zod";
import { Request } from "express";
import { config } from "../../config";
import {
  flattenOpenAIMessageContent,
  OpenAIChatMessage,
  OpenAIV1ChatCompletionSchema,
} from "./openai";

const CLAUDE_OUTPUT_MAX = config.maxOutputTokensAnthropic;

const AnthropicV1BaseSchema = z
  .object({
    model: z.string().max(100),
    stop_sequences: z.array(z.string().max(500)).optional(),
    stream: z.boolean().optional().default(false),
    temperature: z.coerce.number().optional().default(1),
    top_k: z.coerce.number().optional(),
    top_p: z.coerce.number().optional(),
    metadata: z.object({ user_id: z.string().optional() }).optional(),
  })
  .strip();

// https://docs.anthropic.com/claude/reference/complete_post [deprecated]
export const AnthropicV1TextSchema = AnthropicV1BaseSchema.merge(
  z.object({
    prompt: z.string(),
    max_tokens_to_sample: z.coerce
      .number()
      .int()
      .transform((v) => Math.min(v, CLAUDE_OUTPUT_MAX)),
  })
);

const AnthropicV1MessageMultimodalContentSchema = z.array(
  z.union([
    z.object({ type: z.literal("text"), text: z.string() }),
    z.object({
      type: z.literal("image"),
      source: z.object({
        type: z.literal("base64"),
        media_type: z.string().max(100),
        data: z.string(),
      }),
    }),
  ])
);

// https://docs.anthropic.com/claude/reference/messages_post
export const AnthropicV1MessagesSchema = AnthropicV1BaseSchema.merge(
  z.object({
    messages: z.array(
      z.object({
        role: z.enum(["user", "assistant"]),
        content: z.union([
          z.string(),
          AnthropicV1MessageMultimodalContentSchema,
        ]),
      })
    ),
    max_tokens: z
      .number()
      .int()
      .transform((v) => Math.min(v, CLAUDE_OUTPUT_MAX)),
    system: z.string().optional(),
  })
);
export type AnthropicChatMessage = z.infer<
  typeof AnthropicV1MessagesSchema
>["messages"][0];

export function openAIMessagesToClaudeTextPrompt(
  messages: OpenAIChatMessage[]
) {
  return (
    messages
      .map((m) => {
        let role: string = m.role;
        if (role === "assistant") {
          role = "Assistant";
        } else if (role === "system") {
          role = "System";
        } else if (role === "user") {
          role = "Human";
        }
        const name = m.name?.trim();
        const content = flattenOpenAIMessageContent(m.content);
        // https://console.anthropic.com/docs/prompt-design
        // `name` isn't supported by Anthropic but we can still try to use it.
        return `\n\n${role}: ${name ? `(as ${name}) ` : ""}${content}`;
      })
      .join("") + "\n\nAssistant:"
  );
}

export function openAIToAnthropicText(req: Request) {
  const { body } = req;
  const result = OpenAIV1ChatCompletionSchema.safeParse(body);
  if (!result.success) {
    req.log.warn(
      { issues: result.error.issues, body },
      "Invalid OpenAI-to-Anthropic Text request"
    );
    throw result.error;
  }

  req.headers["anthropic-version"] = "2023-06-01";

  const { messages, ...rest } = result.data;
  const prompt = openAIMessagesToClaudeTextPrompt(messages);

  let stops = rest.stop
    ? Array.isArray(rest.stop)
      ? rest.stop
      : [rest.stop]
    : [];
  // Recommended by Anthropic
  stops.push("\n\nHuman:");
  // Helps with jailbreak prompts that send fake system messages and multi-bot
  // chats that prefix bot messages with "System: Respond as <bot name>".
  stops.push("\n\nSystem:");
  // Remove duplicates
  stops = [...new Set(stops)];

  return {
    model: rest.model,
    prompt: prompt,
    max_tokens_to_sample: rest.max_tokens,
    stop_sequences: stops,
    stream: rest.stream,
    temperature: rest.temperature,
    top_p: rest.top_p,
  };
}

/**
 * Converts an older Anthropic Text Completion prompt to the newer Messages API
 * by splitting the flat text into messages.
 */
export function anthropicTextToAnthropicChat(req: Request) {
  const { body } = req;
  const result = AnthropicV1TextSchema.safeParse(body);
  if (!result.success) {
    req.log.warn(
      { issues: result.error.issues, body },
      "Invalid Anthropic Text-to-Anthropic Chat request"
    );
    throw result.error;
  }

  req.headers["anthropic-version"] = "2023-06-01";

  const { model, max_tokens_to_sample, prompt, ...rest } = result.data;
  validateAnthropicTextPrompt(prompt);

  // Iteratively slice the prompt into messages. Start from the beginning and
  // look for the next `\n\nHuman:` or `\n\nAssistant:`. Anything before the
  // first human message is a system message.
  let index = prompt.indexOf("\n\nHuman:");
  let remaining = prompt.slice(index);
  const system = prompt.slice(0, index);
  const messages: AnthropicChatMessage[] = [];
  while (remaining) {
    const isHuman = remaining.startsWith("\n\nHuman:");

    // TODO: Are multiple consecutive human or assistant messages allowed?
    // Currently we will enforce alternating turns.
    const thisRole = isHuman ? "\n\nHuman:" : "\n\nAssistant:";
    const nextRole = isHuman ? "\n\nAssistant:" : "\n\nHuman:";
    const nextIndex = remaining.indexOf(nextRole);

    // Collect text up to the next message, or the end of the prompt for the
    // Assistant prefill if present.
    const msg = remaining
      .slice(0, nextIndex === -1 ? undefined : nextIndex)
      .replace(thisRole, "")
      .trimStart();

    const role = isHuman ? "user" : "assistant";
    messages.push({ role, content: msg });
    remaining = remaining.slice(nextIndex);

    if (nextIndex === -1) break;
  }

  // fix "messages: final assistant content cannot end with trailing whitespace"
  const lastMessage = messages[messages.length - 1];
  if (
    lastMessage.role === "assistant" &&
    typeof lastMessage.content === "string"
  ) {
    messages[messages.length - 1].content = lastMessage.content.trimEnd();
  }

  return {
    model,
    system,
    messages,
    max_tokens: max_tokens_to_sample,
    ...rest,
  };
}

function validateAnthropicTextPrompt(prompt: string) {
  if (!prompt.includes("\n\nHuman:") || !prompt.includes("\n\nAssistant:")) {
    throw new Error(
      "Prompt must contain at least one human and one assistant message."
    );
  }
  // First human message must be before first assistant message
  const firstHuman = prompt.indexOf("\n\nHuman:");
  const firstAssistant = prompt.indexOf("\n\nAssistant:");
  if (firstAssistant < firstHuman) {
    throw new Error(
      "First Assistant message must come after the first Human message."
    );
  }
}

export function flattenAnthropicMessages(
  messages: AnthropicChatMessage[]
): string {
  return messages
    .map((msg) => {
      const name = msg.role === "user" ? "\n\nHuman: " : "\n\nAssistant: ";
      const parts = Array.isArray(msg.content)
        ? msg.content
        : [{ type: "text", text: msg.content }];
      return `${name}: ${parts
        .map((part) =>
          part.type === "text"
            ? part.text
            : `[Omitted multimodal content of type ${part.type}]`
        )
        .join("\n")}`;
    })
    .join("\n\n");
}
