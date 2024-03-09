import { z } from "zod";
import {
  flattenOpenAIChatMessages,
  OpenAIV1ChatCompletionSchema,
} from "./openai";
import { APIFormatTransformer } from "./index";

export const OpenAIV1TextCompletionSchema = z
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

export const transformOpenAIToOpenAIText: APIFormatTransformer<
  typeof OpenAIV1TextCompletionSchema
> = async (req) => {
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
};
