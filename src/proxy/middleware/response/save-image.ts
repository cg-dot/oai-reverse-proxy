import { ProxyResHandlerWithBody } from "./index";
import { mirrorGeneratedImage, OpenAIImageGenerationResult } from "../../../shared/file-storage/mirror-generated-image";

export const saveImage: ProxyResHandlerWithBody = async (
  _proxyRes,
  req,
  _res,
  body,
) => {
  if (req.outboundApi !== "openai-image") {
    return;
  }

  if (typeof body !== "object") {
    throw new Error("Expected body to be an object");
  }

  if (body.data) {
    const baseUrl = req.protocol + "://" + req.get("host");
    const prompt = body.data[0].revised_prompt ?? req.body.prompt;
    await mirrorGeneratedImage(
      baseUrl,
      prompt,
      body as OpenAIImageGenerationResult
    );
  }
};
