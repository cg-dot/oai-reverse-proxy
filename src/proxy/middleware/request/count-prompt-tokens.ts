import { RequestPreprocessor } from "./index";
import { countTokens, OpenAIPromptMessage } from "../../../shared/tokenization";
import { assertNever } from "../../../shared/utils";

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
      const prompt: OpenAIPromptMessage[] = req.body.messages;
      result = await countTokens({ req, prompt, service });
      break;
    }
    case "openai-text": {
      req.outputTokens = req.body.max_tokens;
      const prompt: string = req.body.prompt;
      result = await countTokens({ req, prompt, service });
      break;
    }
    case "anthropic": {
      req.outputTokens = req.body.max_tokens_to_sample;
      const prompt: string = req.body.prompt;
      result = await countTokens({ req, prompt, service });
      break;
    }
    case "google-palm": {
      req.outputTokens = req.body.maxOutputTokens;
      const prompt: string = req.body.prompt.text;
      result = await countTokens({ req, prompt, service });
      break;
    }
    default:
      assertNever(service);
  }

  req.promptTokens = result.token_count;

  // TODO: Remove once token counting is stable
  req.log.debug({ result: result }, "Counted prompt tokens.");
  req.debug = req.debug ?? {};
  req.debug = { ...req.debug, ...result };
};