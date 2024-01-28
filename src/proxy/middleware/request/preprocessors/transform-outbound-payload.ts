import { Request } from "express";
import { z } from "zod";
import { config } from "../../../../config";
import {
  isTextGenerationRequest,
  isImageGenerationRequest,
} from "../../common";
import { RequestPreprocessor } from "../index";
import { APIFormat } from "../../../../shared/key-management";

const CLAUDE_OUTPUT_MAX = config.maxOutputTokensAnthropic;
const OPENAI_OUTPUT_MAX = config.maxOutputTokensOpenAI;

// TODO: move schemas to shared

// https://console.anthropic.com/docs/api/reference#-v1-complete
export const AnthropicV1CompleteSchema = z
  .object({
    model: z.string().max(100),
    prompt: z.string({
      required_error:
        "No prompt found. Are you sending an OpenAI-formatted request to the Claude endpoint?",
    }),
    max_tokens_to_sample: z.coerce
      .number()
      .int()
      .transform((v) => Math.min(v, CLAUDE_OUTPUT_MAX)),
    stop_sequences: z.array(z.string().max(500)).optional(),
    stream: z.boolean().optional().default(false),
    temperature: z.coerce.number().optional().default(1),
    top_k: z.coerce.number().optional(),
    top_p: z.coerce.number().optional(),
  })
  .strip();

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

const OpenAIV1TextCompletionSchema = z
  .object({
    model: z
      .string()
      .max(100)
      .regex(
        /^gpt-3.5-turbo-instruct/,
        "Model must start with 'gpt-3.5-turbo-instruct'"
      ),
    prompt: z.string({
      required_error:
        "No `prompt` found. Ensure you've set the correct completion endpoint.",
    }),
    logprobs: z.number().int().nullish().default(null),
    echo: z.boolean().optional().default(false),
    best_of: z.literal(1).optional(),
    stop: z
      .union([z.string().max(500), z.array(z.string().max(500)).max(4)])
      .optional(),
    suffix: z.string().max(1000).optional(),
  })
  .strip()
  .merge(OpenAIV1ChatCompletionSchema.omit({ messages: true, logprobs: true }));

// https://platform.openai.com/docs/api-reference/images/create
const OpenAIV1ImagesGenerationSchema = z
  .object({
    prompt: z.string().max(4000),
    model: z.string().max(100).optional(),
    quality: z.enum(["standard", "hd"]).optional().default("standard"),
    n: z.number().int().min(1).max(4).optional().default(1),
    response_format: z.enum(["url", "b64_json"]).optional(),
    size: z
      .enum(["256x256", "512x512", "1024x1024", "1792x1024", "1024x1792"])
      .optional()
      .default("1024x1024"),
    style: z.enum(["vivid", "natural"]).optional().default("vivid"),
    user: z.string().max(500).optional(),
  })
  .strip();

// https://developers.generativeai.google/api/rest/generativelanguage/models/generateContent
const GoogleAIV1GenerateContentSchema = z
  .object({
    model: z.string().max(100), //actually specified in path but we need it for the router
    stream: z.boolean().optional().default(false), // also used for router
    contents: z.array(
      z.object({
        parts: z.array(z.object({ text: z.string() })),
        role: z.enum(["user", "model"]),
      })
    ),
    tools: z.array(z.object({})).max(0).optional(),
    safetySettings: z.array(z.object({})).max(0).optional(),
    generationConfig: z.object({
      temperature: z.number().optional(),
      maxOutputTokens: z.coerce
        .number()
        .int()
        .optional()
        .default(16)
        .transform((v) => Math.min(v, 1024)), // TODO: Add config
      candidateCount: z.literal(1).optional(),
      topP: z.number().optional(),
      topK: z.number().optional(),
      stopSequences: z.array(z.string().max(500)).max(5).optional(),
    }),
  })
  .strip();

export type GoogleAIChatMessage = z.infer<
  typeof GoogleAIV1GenerateContentSchema
>["contents"][0];

// https://docs.mistral.ai/api#operation/createChatCompletion
const MistralAIV1ChatCompletionsSchema = z.object({
  model: z.string(),
  messages: z.array(
    z.object({
      role: z.enum(["system", "user", "assistant"]),
      content: z.string(),
    })
  ),
  temperature: z.number().optional().default(0.7),
  top_p: z.number().optional().default(1),
  max_tokens: z.coerce
    .number()
    .int()
    .nullish()
    .transform((v) => Math.min(v ?? OPENAI_OUTPUT_MAX, OPENAI_OUTPUT_MAX)),
  stream: z.boolean().optional().default(false),
  safe_prompt: z.boolean().optional().default(false),
  random_seed: z.number().int().optional(),
});

export type MistralAIChatMessage = z.infer<
  typeof MistralAIV1ChatCompletionsSchema
>["messages"][0];

const VALIDATORS: Record<APIFormat, z.ZodSchema<any>> = {
  anthropic: AnthropicV1CompleteSchema,
  openai: OpenAIV1ChatCompletionSchema,
  "openai-text": OpenAIV1TextCompletionSchema,
  "openai-image": OpenAIV1ImagesGenerationSchema,
  "google-ai": GoogleAIV1GenerateContentSchema,
  "mistral-ai": MistralAIV1ChatCompletionsSchema,
};

/** Transforms an incoming request body to one that matches the target API. */
export const transformOutboundPayload: RequestPreprocessor = async (req) => {
  const sameService = req.inboundApi === req.outboundApi;
  const alreadyTransformed = req.retryCount > 0;
  const notTransformable =
    !isTextGenerationRequest(req) && !isImageGenerationRequest(req);

  if (alreadyTransformed || notTransformable) return;

  if (req.inboundApi === "mistral-ai") {
    const messages = req.body.messages;
    req.body.messages = fixMistralPrompt(messages);
    req.log.info(
      { old: messages.length, new: req.body.messages.length },
      "Fixed Mistral prompt"
    );
  }

  if (sameService) {
    const result = VALIDATORS[req.inboundApi].safeParse(req.body);
    if (!result.success) {
      req.log.error(
        { issues: result.error.issues, body: req.body },
        "Request validation failed"
      );
      throw result.error;
    }
    req.body = result.data;
    return;
  }

  if (req.inboundApi === "openai" && req.outboundApi === "anthropic") {
    req.body = openaiToAnthropic(req);
    return;
  }

  if (req.inboundApi === "openai" && req.outboundApi === "google-ai") {
    req.body = openaiToGoogleAI(req);
    return;
  }

  if (req.inboundApi === "openai" && req.outboundApi === "openai-text") {
    req.body = openaiToOpenaiText(req);
    return;
  }

  if (req.inboundApi === "openai" && req.outboundApi === "openai-image") {
    req.body = openaiToOpenaiImage(req);
    return;
  }

  throw new Error(
    `'${req.inboundApi}' -> '${req.outboundApi}' request proxying is not supported. Make sure your client is configured to use the correct API.`
  );
};

function openaiToAnthropic(req: Request) {
  const { body } = req;
  const result = OpenAIV1ChatCompletionSchema.safeParse(body);
  if (!result.success) {
    req.log.warn(
      { issues: result.error.issues, body },
      "Invalid OpenAI-to-Anthropic request"
    );
    throw result.error;
  }

  req.headers["anthropic-version"] = "2023-06-01";

  const { messages, ...rest } = result.data;
  const prompt = openAIMessagesToClaudePrompt(messages);

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

function openaiToOpenaiText(req: Request) {
  const { body } = req;
  const result = OpenAIV1ChatCompletionSchema.safeParse(body);
  if (!result.success) {
    req.log.warn(
      { issues: result.error.issues, body },
      "Invalid OpenAI-to-OpenAI-text request"
    );
    throw result.error;
  }

  const { messages, ...rest } = result.data;
  const prompt = flattenOpenAIChatMessages(messages);

  let stops = rest.stop
    ? Array.isArray(rest.stop)
      ? rest.stop
      : [rest.stop]
    : [];
  stops.push("\n\nUser:");
  stops = [...new Set(stops)];

  const transformed = { ...rest, prompt: prompt, stop: stops };
  return OpenAIV1TextCompletionSchema.parse(transformed);
}

// Takes the last chat message and uses it verbatim as the image prompt.
function openaiToOpenaiImage(req: Request) {
  const { body } = req;
  const result = OpenAIV1ChatCompletionSchema.safeParse(body);
  if (!result.success) {
    req.log.warn(
      { issues: result.error.issues, body },
      "Invalid OpenAI-to-OpenAI-image request"
    );
    throw result.error;
  }

  const { messages } = result.data;
  const prompt = messages.filter((m) => m.role === "user").pop()?.content;
  if (Array.isArray(prompt)) {
    throw new Error("Image generation prompt must be a text message.");
  }

  if (body.stream) {
    throw new Error(
      "Streaming is not supported for image generation requests."
    );
  }

  // Some frontends do weird things with the prompt, like prefixing it with a
  // character name or wrapping the entire thing in quotes. We will look for
  // the index of "Image:" and use everything after that as the prompt.

  const index = prompt?.toLowerCase().indexOf("image:");
  if (index === -1 || !prompt) {
    throw new Error(
      `Start your prompt with 'Image:' followed by a description of the image you want to generate (received: ${prompt}).`
    );
  }

  // TODO: Add some way to specify parameters via chat message
  const transformed = {
    model: body.model.includes("dall-e") ? body.model : "dall-e-3",
    quality: "standard",
    size: "1024x1024",
    response_format: "url",
    prompt: prompt.slice(index! + 6).trim(),
  };
  return OpenAIV1ImagesGenerationSchema.parse(transformed);
}

function openaiToGoogleAI(
  req: Request
): z.infer<typeof GoogleAIV1GenerateContentSchema> {
  const { body } = req;
  const result = OpenAIV1ChatCompletionSchema.safeParse({
    ...body,
    model: "gpt-3.5-turbo",
  });
  if (!result.success) {
    req.log.warn(
      { issues: result.error.issues, body },
      "Invalid OpenAI-to-Google AI request"
    );
    throw result.error;
  }

  const { messages, ...rest } = result.data;
  const foundNames = new Set<string>();
  const contents = messages
    .map((m) => {
      const role = m.role === "assistant" ? "model" : "user";
      // Detects character names so we can set stop sequences for them as Gemini
      // is prone to continuing as the next character.
      // If names are not available, we'll still try to prefix the message
      // with generic names so we can set stops for them but they don't work
      // as well as real names.
      const text = flattenOpenAIMessageContent(m.content);
      const propName = m.name?.trim();
      const textName =
        m.role === "system" ? "" : text.match(/^(.{0,50}?): /)?.[1]?.trim();
      const name =
        propName || textName || (role === "model" ? "Character" : "User");

      foundNames.add(name);

      // Prefixing messages with their character name seems to help avoid
      // Gemini trying to continue as the next character, or at the very least
      // ensures it will hit the stop sequence.  Otherwise it will start a new
      // paragraph and switch perspectives.
      // The response will be very likely to include this prefix so frontends
      // will need to strip it out.
      const textPrefix = textName ? "" : `${name}: `;
      return {
        parts: [{ text: textPrefix + text }],
        role: m.role === "assistant" ? ("model" as const) : ("user" as const),
      };
    })
    .reduce<GoogleAIChatMessage[]>((acc, msg) => {
      const last = acc[acc.length - 1];
      if (last?.role === msg.role) {
        last.parts[0].text += "\n\n" + msg.parts[0].text;
      } else {
        acc.push(msg);
      }
      return acc;
    }, []);

  let stops = rest.stop
    ? Array.isArray(rest.stop)
      ? rest.stop
      : [rest.stop]
    : [];
  stops.push(...Array.from(foundNames).map((name) => `\n${name}:`));
  stops = [...new Set(stops)].slice(0, 5);

  return {
    model: "gemini-pro",
    stream: rest.stream,
    contents,
    tools: [],
    generationConfig: {
      maxOutputTokens: rest.max_tokens,
      stopSequences: stops,
      topP: rest.top_p,
      topK: 40, // openai schema doesn't have this, google ai defaults to 40
      temperature: rest.temperature,
    },
    safetySettings: [
      { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
      { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
      { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
      { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" },
    ],
  };
}

export function openAIMessagesToClaudePrompt(messages: OpenAIChatMessage[]) {
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

function flattenOpenAIChatMessages(messages: OpenAIChatMessage[]) {
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

function flattenOpenAIMessageContent(
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

function fixMistralPrompt(
  messages: MistralAIChatMessage[]
): MistralAIChatMessage[] {
  // Mistral uses OpenAI format but has some additional requirements:
  // - Only one system message per request, and it must be the first message if
  //   present.
  // - Final message must be a user message.
  // - Cannot have multiple messages from the same role in a row.
  // While frontends should be able to handle this, we can fix it here in the
  // meantime.

  const result = messages.reduce<MistralAIChatMessage[]>((acc, msg) => {
    if (acc.length === 0) {
      acc.push(msg);
      return acc;
    }
    
    const copy = { ...msg };
    // Reattribute subsequent system messages to the user
    if (msg.role === "system") {
      copy.role = "user";
    }

    // Consolidate multiple messages from the same role
    const last = acc[acc.length - 1];
    if (last.role === copy.role) {
      last.content += "\n\n" + copy.content;
    } else {
      acc.push(copy);
    }
    return acc;
  }, []);

  return result;
}
