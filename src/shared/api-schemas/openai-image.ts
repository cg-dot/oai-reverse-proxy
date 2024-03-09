import { z } from "zod";
import { OpenAIV1ChatCompletionSchema } from "./openai";
import { APIFormatTransformer } from "./index";

// https://platform.openai.com/docs/api-reference/images/create
export const OpenAIV1ImagesGenerationSchema = z
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

// Takes the last chat message and uses it verbatim as the image prompt.
export const transformOpenAIToOpenAIImage: APIFormatTransformer<
  typeof OpenAIV1ImagesGenerationSchema
> = async (req) => {
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
};
