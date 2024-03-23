import { config } from "../../../../config";
import { assertNever } from "../../../../shared/utils";
import { RequestPreprocessor } from "../index";
import { containsImageContent as containsImageContentOpenAI } from "../../../../shared/api-schemas/openai";
import { containsImageContent as containsImageContentAnthropic } from "../../../../shared/api-schemas/anthropic";
import { ForbiddenError } from "../../../../shared/errors";

/**
 * Rejects prompts containing images if multimodal prompts are disabled.
 */
export const validateVision: RequestPreprocessor = async (req) => {
  if (config.allowImagePrompts) return;
  if (req.user?.type === "special") return;

  let hasImage = false;
  switch (req.outboundApi) {
    case "openai":
      hasImage = containsImageContentOpenAI(req.body.messages);
      break;
    case "anthropic-chat":
      hasImage = containsImageContentAnthropic(req.body.messages);
      break;
    case "anthropic-text":
    case "google-ai":
    case "mistral-ai":
    case "openai-image":
    case "openai-text":
      return;
    default:
      assertNever(req.outboundApi);
  }

  if (hasImage) {
    throw new ForbiddenError(
      "Prompts containing images are not permitted. Disable 'Send Inline Images' in your client and try again."
    );
  }
};
