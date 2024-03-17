import { z } from "zod";
import { config } from "../../config";
import { BadRequestError } from "../errors";
import {
  flattenOpenAIMessageContent,
  OpenAIChatMessage,
  OpenAIV1ChatCompletionSchema,
} from "./openai";
import { APIFormatTransformer } from "./index";

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

function openAIMessagesToClaudeTextPrompt(messages: OpenAIChatMessage[]) {
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

export const transformOpenAIToAnthropicChat: APIFormatTransformer<
  typeof AnthropicV1MessagesSchema
> = async (req) => {
  const { body } = req;
  const result = OpenAIV1ChatCompletionSchema.safeParse(body);
  if (!result.success) {
    req.log.warn(
      { issues: result.error.issues, body },
      "Invalid OpenAI-to-Anthropic Chat request"
    );
    throw result.error;
  }

  req.headers["anthropic-version"] = "2023-06-01";

  const { messages, ...rest } = result.data;
  const { messages: newMessages, system } =
    openAIMessagesToClaudeChatPrompt(messages);

  return {
    system,
    messages: newMessages,
    model: rest.model,
    max_tokens: rest.max_tokens,
    stream: rest.stream,
    temperature: rest.temperature,
    top_p: rest.top_p,
    stop_sequences: typeof rest.stop === "string" ? [rest.stop] : rest.stop,
    ...(rest.user ? { metadata: { user_id: rest.user } } : {}),
    // Anthropic supports top_k, but OpenAI does not
    // OpenAI supports frequency_penalty, presence_penalty, logit_bias, n, seed,
    // and function calls, but Anthropic does not.
  };
};

export const transformOpenAIToAnthropicText: APIFormatTransformer<
  typeof AnthropicV1TextSchema
> = async (req) => {
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
};

/**
 * Converts an older Anthropic Text Completion prompt to the newer Messages API
 * by splitting the flat text into messages.
 */
export const transformAnthropicTextToAnthropicChat: APIFormatTransformer<
  typeof AnthropicV1MessagesSchema
> = async (req) => {
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

    // Multiple messages from the same role are not permitted in Messages API.
    // We collect all messages until the next message from the opposite role.
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
};

function validateAnthropicTextPrompt(prompt: string) {
  if (!prompt.includes("\n\nHuman:") || !prompt.includes("\n\nAssistant:")) {
    throw new BadRequestError(
      "Prompt must contain at least one human and one assistant message."
    );
  }
  // First human message must be before first assistant message
  const firstHuman = prompt.indexOf("\n\nHuman:");
  const firstAssistant = prompt.indexOf("\n\nAssistant:");
  if (firstAssistant < firstHuman) {
    throw new BadRequestError(
      "First Assistant message must come after the first Human message."
    );
  }
}

export function flattenAnthropicMessages(
  messages: AnthropicChatMessage[]
): string {
  return messages
    .map((msg) => {
      const name = msg.role === "user" ? "Human" : "Assistant";
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

/**
 * Represents the union of all content types without the `string` shorthand
 * for `text` content.
 */
type AnthropicChatMessageContentWithoutString = Exclude<
  AnthropicChatMessage["content"],
  string
>;
/** Represents a message with all shorthand `string` content expanded. */
type ConvertedAnthropicChatMessage = AnthropicChatMessage & {
  content: AnthropicChatMessageContentWithoutString;
};

function openAIMessagesToClaudeChatPrompt(messages: OpenAIChatMessage[]): {
  messages: AnthropicChatMessage[];
  system: string;
} {
  // Similar formats, but Claude doesn't use `name` property and doesn't have
  // a `system` role.  Also, Claude does not allow consecutive messages from
  // the same role, so we need to merge them.
  // 1. Collect all system messages up to the first non-system message and set
  // that as the `system` prompt.
  // 2. Iterate through messages and:
  //   - If the message is from system, reassign it to assistant with System:
  //     prefix.
  //   - If message is from same role as previous, append it to the previous
  //     message rather than creating a new one.
  //   - Otherwise, create a new message and prefix with `name` if present.

  // TODO: When a Claude message has multiple `text` contents, does the internal
  // message flattening insert newlines between them?  If not, we may need to
  // do that here...

  let firstNonSystem = -1;
  const result: { messages: ConvertedAnthropicChatMessage[]; system: string } =
    { messages: [], system: "" };
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    const isSystem = isSystemOpenAIRole(msg.role);

    if (firstNonSystem === -1 && isSystem) {
      // Still merging initial system messages into the system prompt
      result.system += getFirstTextContent(msg.content) + "\n";
      continue;
    }

    if (firstNonSystem === -1 && !isSystem) {
      // Encountered the first non-system message
      firstNonSystem = i;

      if (msg.role === "assistant") {
        // There is an annoying rule that the first message must be from the user.
        // This is commonly not the case with roleplay prompts that start with a
        // block of system messages followed by an assistant message. We will try
        // to reconcile this by splicing the last line of the system prompt into
        // a beginning user message -- this is *commonly* ST's [Start a new chat]
        // nudge, which works okay as a user message.

        // Find the last non-empty line in the system prompt
        const execResult = /(?:[^\r\n]*\r?\n)*([^\r\n]+)(?:\r?\n)*/d.exec(
          result.system
        );

        let text = "";
        if (execResult) {
          text = execResult[1];
          // Remove last line from system so it doesn't get duplicated
          const [_, [lastLineStart]] = execResult.indices || [];
          result.system = result.system.slice(0, lastLineStart);
        } else {
          // This is a bad prompt; there's no system content to move to user and
          // it starts with assistant. We don't have any good options.
          text = "[ Joining chat... ]";
        }

        result.messages.push({
          role: "user",
          content: [{ type: "text", text }],
        });
      }
    }

    const last = result.messages[result.messages.length - 1];
    // I have to handle tools as system messages to be exhaustive here but the
    // experience will be bad.
    const role = isSystemOpenAIRole(msg.role) ? "assistant" : msg.role;

    // Here we will lose the original name if it was a system message, but that
    // is generally okay because the system message is usually a prompt and not
    // a character in the chat.
    const name = msg.role === "system" ? "System" : msg.name?.trim();
    const content = convertOpenAIContent(msg.content);

    // Prepend the display name to the first text content in the current message
    // if it exists. We don't need to add the name to every content block.
    if (name?.length) {
      const firstTextContent = content.find((c) => c.type === "text");
      if (firstTextContent && "text" in firstTextContent) {
        // This mutates the element in `content`.
        firstTextContent.text = `${name}: ${firstTextContent.text}`;
      }
    }

    // Merge messages if necessary. If two assistant roles are consecutive but
    // had different names, the final converted assistant message will have
    // multiple characters in it, but the name prefixes should assist the model
    // in differentiating between speakers.
    if (last && last.role === role) {
      last.content.push(...content);
    } else {
      result.messages.push({ role, content });
    }
  }

  result.system = result.system.trimEnd();
  return result;
}

function isSystemOpenAIRole(
  role: OpenAIChatMessage["role"]
): role is "system" | "function" | "tool" {
  return ["system", "function", "tool"].includes(role);
}

function getFirstTextContent(content: OpenAIChatMessage["content"]) {
  if (typeof content === "string") return content;
  for (const c of content) {
    if ("text" in c) return c.text;
  }
  return "[ No text content in this message ]";
}

function convertOpenAIContent(
  content: OpenAIChatMessage["content"]
): AnthropicChatMessageContentWithoutString {
  if (typeof content === "string") {
    return [{ type: "text", text: content.trimEnd() }];
  }

  return content.map((c) => {
    if ("text" in c) {
      return { type: "text", text: c.text.trimEnd() };
    } else if ("image_url" in c) {
      const url = c.image_url.url;
      try {
        const mimeType = url.split(";")[0].split(":")[1];
        const data = url.split(",")[1];
        return {
          type: "image",
          source: { type: "base64", media_type: mimeType, data },
        };
      } catch (e) {
        return {
          type: "text",
          text: `[ Unsupported image URL: ${url.slice(0, 200)} ]`,
        };
      }
    } else {
      const type = String((c as any)?.type);
      return { type: "text", text: `[ Unsupported content type: ${type} ]` };
    }
  });
}
