import { Request } from "express";
import { z } from "zod";
import type { ExpressHttpProxyReqCallback } from ".";

// https://console.anthropic.com/docs/api/reference#-v1-complete
const AnthropicV1CompleteSchema = z.object({
  model: z.string().regex(/^claude-/),
  prompt: z.string(),
  max_tokens_to_sample: z.number(),
  stop_sequences: z.array(z.string()).optional(),
  stream: z.boolean().optional().default(false),
  temperature: z.number().optional().default(1),
  top_k: z.number().optional().default(-1),
  top_p: z.number().optional().default(-1),
  metadata: z.any().optional(),
});

// https://platform.openai.com/docs/api-reference/chat/create
const OpenAIV1ChatCompletionSchema = z.object({
  model: z.string().regex(/^gpt/),
  messages: z.array(
    z.object({
      role: z.enum(["system", "user", "assistant"]),
      content: z.string(),
      name: z.string().optional(),
    })
  ),
  temperature: z.number().optional().default(1),
  top_p: z.number().optional().default(1),
  n: z.literal(1).optional(),
  stream: z.boolean().optional().default(false),
  stop: z.union([z.string(), z.array(z.string())]).optional(),
  max_tokens: z.number().optional(),
  frequency_penalty: z.number().optional().default(0),
  presence_penalty: z.number().optional().default(0),
  logit_bias: z.any().optional(),
  user: z.string().optional(),
});

/** Transforms an incoming request body to one that matches the target API. */
export const transformOutboundPayload: ExpressHttpProxyReqCallback = (
  _proxyReq,
  req
) => {
  if (req.retryCount > 0) {
    // We've already transformed the payload once, so don't do it again.
    return;
  }

  const inboundService = req.api;
  const outboundService = req.key!.service;

  if (inboundService === outboundService) {
    return;
  }

  // Not supported yet and unnecessary as everything supports OpenAI.
  if (inboundService === "anthropic" && outboundService === "openai") {
    throw new Error(
      "Anthropic -> OpenAI request transformation not supported. Provide an OpenAI-compatible payload, or use the /claude endpoint."
    );
  }

  if (inboundService === "openai" && outboundService === "anthropic") {
    req.body = openaiToAnthropic(req.body, req);
    return;
  }

  throw new Error(
    `Unsupported transformation: ${inboundService} -> ${outboundService}`
  );
};

function openaiToAnthropic(body: any, req: Request) {
  const result = OpenAIV1ChatCompletionSchema.safeParse(body);
  if (!result.success) {
    // don't log the prompt
    const { messages, ...params } = body;
    req.log.error(
      { issues: result.error.issues, params },
      "Invalid OpenAI-to-Anthropic request"
    );
    throw result.error;
  }

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

  // When translating from OpenAI to Anthropic, we obviously can't use the
  // provided OpenAI model name as-is. We will instead select a Claude model,
  // choosing either the 100k token model or the 9k token model depending on
  // the length of the prompt. I'm not bringing in the full OpenAI tokenizer for
  // this so we'll use Anthropic's guideline of ~28000 characters to about 8k
  // tokens (https://console.anthropic.com/docs/prompt-design#prompt-length)
  // as the cutoff, minus a little bit for safety.

  // For smaller prompts we use 1.2 because it's not as annoying as 1.3
  // For big prompts (v1, auto-selects the latest model) is all we can use.
  const model = prompt.length > 25000 ? "claude-v1-100k" : "claude-v1.2";

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
    prompt,
    max_tokens_to_sample: rest.max_tokens,
    stop_sequences: stops,
  };
}
