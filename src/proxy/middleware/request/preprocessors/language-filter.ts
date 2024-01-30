import { Request } from "express";
import { config } from "../../../../config";
import { assertNever } from "../../../../shared/utils";
import { RequestPreprocessor } from "../index";
import { UserInputError } from "../../../../shared/errors";
import {
  MistralAIChatMessage,
  OpenAIChatMessage,
} from "../../../../shared/api-schemas";

const rejectedClients = new Map<string, number>();

setInterval(() => {
  rejectedClients.forEach((count, ip) => {
    if (count > 0) {
      rejectedClients.set(ip, Math.floor(count / 2));
    } else {
      rejectedClients.delete(ip);
    }
  });
}, 30000);

/**
 * Block requests containing blacklisted phrases. Repeated rejections from the
 * same IP address will be throttled.
 */
export const languageFilter: RequestPreprocessor = async (req) => {
  if (!config.rejectPhrases.length) return;

  const prompt = getPromptFromRequest(req);
  const match = config.rejectPhrases.find((phrase) =>
    prompt.match(new RegExp(phrase, "i"))
  );

  if (match) {
    const ip = req.ip;
    const rejections = (rejectedClients.get(req.ip) || 0) + 1;
    const delay = Math.min(60000, Math.pow(2, rejections - 1) * 1000);
    rejectedClients.set(ip, rejections);
    req.log.warn(
      { match, ip, rejections, delay },
      "Prompt contains rejected phrase"
    );
    await new Promise((resolve) => {
      req.res!.once("close", resolve);
      setTimeout(resolve, delay);
    });
    throw new UserInputError(config.rejectMessage);
  }
};

function getPromptFromRequest(req: Request) {
  const service = req.outboundApi;
  const body = req.body;
  switch (service) {
    case "anthropic":
      return body.prompt;
    case "openai":
    case "mistral-ai":
      return body.messages
        .map((msg: OpenAIChatMessage | MistralAIChatMessage) => {
          const text = Array.isArray(msg.content)
            ? msg.content
                .map((c) => {
                  if ("text" in c) return c.text;
                })
                .join()
            : msg.content;
          return `${msg.role}: ${text}`;
        })
        .join("\n\n");
    case "openai-text":
    case "openai-image":
      return body.prompt;
    case "google-ai":
      return body.prompt.text;
    default:
      assertNever(service);
  }
}
