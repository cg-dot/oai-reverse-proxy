import { Request } from "express";
import { z } from "zod";
import { isCompletionRequest } from "../common";
import { RequestPreprocessor } from ".";
// import { countTokens } from "../../../tokenization";

// https://console.anthropic.com/docs/api/reference#-v1-complete
const AnthropicV1CompleteSchema = z.object({
  model: z.string().regex(/^claude-/, "Model must start with 'claude-'"),
  prompt: z.string({
    required_error:
      "No prompt found. Are you sending an OpenAI-formatted request to the Claude endpoint?",
  }),
  max_tokens_to_sample: z.coerce.number(),
  stop_sequences: z.array(z.string()).optional(),
  stream: z.boolean().optional().default(false),
  temperature: z.coerce.number().optional().default(1),
  top_k: z.coerce.number().optional().default(-1),
  top_p: z.coerce.number().optional().default(-1),
  metadata: z.any().optional(),
});

// https://platform.openai.com/docs/api-reference/chat/create
const OpenAIV1ChatCompletionSchema = z.object({
  model: z.string().regex(/^gpt/, "Model must start with 'gpt-'"),
  messages: z.array(
    z.object({
      role: z.enum(["system", "user", "assistant"]),
      content: z.string(),
      name: z.string().optional(),
    }),
    {
      required_error:
        "No prompt found. Are you sending an Anthropic-formatted request to the OpenAI endpoint?",
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
  stop: z.union([z.string(), z.array(z.string())]).optional(),
  max_tokens: z.coerce.number().optional(),
  frequency_penalty: z.number().optional().default(0),
  presence_penalty: z.number().optional().default(0),
  logit_bias: z.any().optional(),
  user: z.string().optional(),
});

/** Transforms an incoming request body to one that matches the target API. */
export const transformOutboundPayload: RequestPreprocessor = async (req) => {
  const sameService = req.inboundApi === req.outboundApi;
  const alreadyTransformed = req.retryCount > 0;
  const notTransformable = !isCompletionRequest(req);

  if (alreadyTransformed || notTransformable) {
    return;
  }

  if (sameService) {
    // Just validate, don't transform.
    const validator =
      req.outboundApi === "openai"
        ? OpenAIV1ChatCompletionSchema
        : AnthropicV1CompleteSchema;
    const result = validator.safeParse(req.body);
    if (!result.success) {
      req.log.error(
        { issues: result.error.issues, body: req.body },
        "Request validation failed"
      );
      throw result.error;
    }
    return;
  }

  if (req.inboundApi === "openai" && req.outboundApi === "anthropic") {
    req.body = openaiToAnthropic(req.body, req);
    return;
  }

  throw new Error(
    `'${req.inboundApi}' -> '${req.outboundApi}' request proxying is not supported. Make sure your client is configured to use the correct API.`
  );
};

function openaiToAnthropic(body: any, req: Request) {
  const result = OpenAIV1ChatCompletionSchema.safeParse(body);
  if (!result.success) {
    req.log.error(
      { issues: result.error.issues, body: req.body },
      "Invalid OpenAI-to-Anthropic request"
    );
    throw result.error;
  }

  // Anthropic has started versioning their API, indicated by an HTTP header
  // `anthropic-version`. The new June 2023 version is not backwards compatible
  // with our OpenAI-to-Anthropic transformations so we need to explicitly
  // request the older version for now. 2023-01-01 will be removed in September.
  // https://docs.anthropic.com/claude/reference/versioning
  req.headers["anthropic-version"] = "2023-01-01";

  const { messages, ...rest } = result.data;
  const prompt =
    result.data.messages
      .map((m) => {
        let role: string = m.role;
        if (role === "assistant") {
          role = "Assistant";
        } else if (role === "system") {
          role = "System";
        } else if (role === "user") {
          role = "Human";
        }
        // https://console.anthropic.com/docs/prompt-design
        // `name` isn't supported by Anthropic but we can still try to use it.
        return `\n\n${role}: ${m.name?.trim() ? `(as ${m.name}) ` : ""}${
          m.content
        }`;
      })
      .join("") + "\n\nAssistant: ";

  // No longer defaulting to `claude-v1.2` because it seems to be in the process
  // of being deprecated. `claude-v1` is the new default.
  // If you have keys that can still use `claude-v1.2`, you can set the
  // CLAUDE_BIG_MODEL and CLAUDE_SMALL_MODEL environment variables in your .env
  // file.

  const CLAUDE_BIG = process.env.CLAUDE_BIG_MODEL || "claude-v1-100k";
  const CLAUDE_SMALL = process.env.CLAUDE_SMALL_MODEL || "claude-v1";

  // TODO: Finish implementing tokenizer for more accurate model selection.
  // This currently uses _character count_, not token count.
  const model = prompt.length > 25000 ? CLAUDE_BIG : CLAUDE_SMALL;

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
    ...rest,
    model,
    prompt: prompt,
    max_tokens_to_sample: rest.max_tokens,
    stop_sequences: stops,
  };
}
