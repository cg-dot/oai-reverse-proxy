import { RequestPreprocessor } from "../index";
import { countTokens } from "../../../../shared/tokenization";
import { assertNever } from "../../../../shared/utils";
import {
  AnthropicChatMessage,
  GoogleAIChatMessage,
  MistralAIChatMessage,
  OpenAIChatMessage,
} from "../../../../shared/api-schemas";

/**
 * Given a request with an already-transformed body, counts the number of
 * tokens and assigns the count to the request.
 */
export const countPromptTokens: RequestPreprocessor = async (req) => {
  const service = req.outboundApi;
  let result;

  switch (service) {
    case "openai": {
      req.outputTokens = req.body.max_tokens;
      const prompt: OpenAIChatMessage[] = req.body.messages;
      result = await countTokens({ req, prompt, service });
      break;
    }
    case "openai-text": {
      req.outputTokens = req.body.max_tokens;
      const prompt: string = req.body.prompt;
      result = await countTokens({ req, prompt, service });
      break;
    }
    case "anthropic-chat": {
      req.outputTokens = req.body.max_tokens;
      const prompt: AnthropicChatMessage[] = req.body.messages;
      result = await countTokens({ req, prompt, service });
      break;
    }
    case "anthropic-text": {
      req.outputTokens = req.body.max_tokens_to_sample;
      const prompt: string = req.body.prompt;
      result = await countTokens({ req, prompt, service });
      break;
    }
    case "google-ai": {
      req.outputTokens = req.body.generationConfig.maxOutputTokens;
      const prompt: GoogleAIChatMessage[] = req.body.contents;
      result = await countTokens({ req, prompt, service });
      break;
    }
    case "mistral-ai": {
      req.outputTokens = req.body.max_tokens;
      const prompt: MistralAIChatMessage[] = req.body.messages;
      result = await countTokens({ req, prompt, service });
      break;
    }
    case "openai-image": {
      req.outputTokens = 1;
      result = await countTokens({ req, service });
      break;
    }
    default:
      assertNever(service);
  }

  req.promptTokens = result.token_count;

  req.log.debug({ result: result }, "Counted prompt tokens.");
  req.tokenizerInfo = req.tokenizerInfo ?? {};
  req.tokenizerInfo = { ...req.tokenizerInfo, ...result };
};
