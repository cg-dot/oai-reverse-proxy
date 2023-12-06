import { AnthropicKey, Key } from "../../../../shared/key-management";
import { isTextGenerationRequest } from "../../common";
import { HPMRequestCallback } from "../index";

/**
 * Some keys require the prompt to start with `\n\nHuman:`. There is no way to
 * know this without trying to send the request and seeing if it fails. If a
 * key is marked as requiring a preamble, it will be added here.
 */
export const addAnthropicPreamble: HPMRequestCallback = (
  _proxyReq,
  req
) => {
  if (!isTextGenerationRequest(req) || req.key?.service !== "anthropic") {
    return;
  }

  let preamble = "";
  let prompt = req.body.prompt;
  assertAnthropicKey(req.key);
  if (req.key.requiresPreamble) {
    preamble = prompt.startsWith("\n\nHuman:") ? "" : "\n\nHuman:";
    req.log.debug({ key: req.key.hash, preamble }, "Adding preamble to prompt");
  }
  req.body.prompt = preamble + prompt;
};

function assertAnthropicKey(key: Key): asserts key is AnthropicKey {
  if (key.service !== "anthropic") {
    throw new Error(`Expected an Anthropic key, got '${key.service}'`);
  }
}
