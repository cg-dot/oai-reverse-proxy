import { z } from "zod";
import { config } from "../../config";

export const OPENAI_OUTPUT_MAX = config.maxOutputTokensOpenAI;

// https://platform.openai.com/docs/api-reference/chat/create
const OpenAIV1ChatContentArraySchema = z.array(
  z.union([
    z.object({ type: z.literal("text"), text: z.string() }),
    z.object({
      type: z.union([z.literal("image"), z.literal("image_url")]),
      image_url: z.object({
        url: z.string().url(),
        detail: z.enum(["low", "auto", "high"]).optional().default("auto"),
      }),
    }),
  ])
);
export const OpenAIV1ChatCompletionSchema = z
  .object({
    model: z.string().max(100),
    messages: z.array(
      z.object({
        role: z.enum(["system", "user", "assistant", "tool", "function"]),
        content: z.union([z.string(), OpenAIV1ChatContentArraySchema]),
        name: z.string().optional(),
        tool_calls: z.array(z.any()).optional(),
        function_call: z.array(z.any()).optional(),
        tool_call_id: z.string().optional(),
      }),
      {
        required_error:
          "No `messages` found. Ensure you've set the correct completion endpoint.",
        invalid_type_error:
          "Messages were not formatted correctly. Refer to the OpenAI Chat API documentation for more information.",
      }
    ),
    temperature: z.number().optional().default(1),
    top_p: z.number().optional().default(1),
    n: z
      .literal(1, {
        errorMap: () => ({
          message: "You may only request a single completion at a time.",
        }),
      })
      .optional(),
    stream: z.boolean().optional().default(false),
    stop: z
      .union([z.string().max(500), z.array(z.string().max(500))])
      .optional(),
    max_tokens: z.coerce
      .number()
      .int()
      .nullish()
      .default(16)
      .transform((v) => Math.min(v ?? OPENAI_OUTPUT_MAX, OPENAI_OUTPUT_MAX)),
    frequency_penalty: z.number().optional().default(0),
    presence_penalty: z.number().optional().default(0),
    logit_bias: z.any().optional(),
    user: z.string().max(500).optional(),
    seed: z.number().int().optional(),
    // Be warned that Azure OpenAI combines these two into a single field.
    // It's the only deviation from the OpenAI API that I'm aware of so I have
    // special cased it in `addAzureKey` rather than expecting clients to do it.
    logprobs: z.boolean().optional(),
    top_logprobs: z.number().int().optional(),
    // Quickly adding some newer tool usage params, not tested. They will be
    // passed through to the API as-is.
    tools: z.array(z.any()).optional(),
    functions: z.array(z.any()).optional(),
    tool_choice: z.any().optional(),
    function_choice: z.any().optional(),
    response_format: z.any(),
  })
  // Tool usage must be enabled via config because we currently have no way to
  // track quota usage for them or enforce limits.
  .omit(
    Boolean(config.allowOpenAIToolUsage) ? {} : { tools: true, functions: true }
  )
  .strip();
export type OpenAIChatMessage = z.infer<
  typeof OpenAIV1ChatCompletionSchema
>["messages"][0];

export function flattenOpenAIMessageContent(
  content: OpenAIChatMessage["content"]
): string {
  return Array.isArray(content)
    ? content
        .map((contentItem) => {
          if ("text" in contentItem) return contentItem.text;
          if ("image_url" in contentItem) return "[ Uploaded Image Omitted ]";
        })
        .join("\n")
    : content;
}

export function flattenOpenAIChatMessages(messages: OpenAIChatMessage[]) {
  // Temporary to allow experimenting with prompt strategies
  const PROMPT_VERSION: number = 1;
  switch (PROMPT_VERSION) {
    case 1:
      return (
        messages
          .map((m) => {
            // Claude-style human/assistant turns
            let role: string = m.role;
            if (role === "assistant") {
              role = "Assistant";
            } else if (role === "system") {
              role = "System";
            } else if (role === "user") {
              role = "User";
            }
            return `\n\n${role}: ${flattenOpenAIMessageContent(m.content)}`;
          })
          .join("") + "\n\nAssistant:"
      );
    case 2:
      return messages
        .map((m) => {
          // Claude without prefixes (except system) and no Assistant priming
          let role: string = "";
          if (role === "system") {
            role = "System: ";
          }
          return `\n\n${role}${flattenOpenAIMessageContent(m.content)}`;
        })
        .join("");
    default:
      throw new Error(`Unknown prompt version: ${PROMPT_VERSION}`);
  }
}
