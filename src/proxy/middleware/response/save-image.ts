import { ProxyResHandlerWithBody } from "./index";
import {
  mirrorGeneratedImage,
  OpenAIImageGenerationResult,
} from "../../../shared/file-storage/mirror-generated-image";

export const saveImage: ProxyResHandlerWithBody = async (
  _proxyRes,
  req,
  _res,
  body
) => {
  if (req.outboundApi !== "openai-image") {
    return;
  }

  if (typeof body !== "object") {
    throw new Error("Expected body to be an object");
  }

  if (body.data) {
    const prompt = body.data[0].revised_prompt ?? req.body.prompt;
    const res = await mirrorGeneratedImage(
      req,
      prompt,
      body as OpenAIImageGenerationResult
    );
    req.log.info(
      { urls: res.data.map((item) => item.url) },
      "Saved generated image to user_content"
    );
  }
};
