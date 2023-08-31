import { ModelFamily } from "../key-management";

// technically slightly underestimates, because completion tokens cost more
// than prompt tokens but we don't track those separately right now
export function getTokenCostUsd(model: ModelFamily, tokens: number) {
  let cost = 0;
  switch (model) {
    case "gpt4-32k":
      cost = 0.00006;
      break;
    case "gpt4":
      cost = 0.00003;
      break;
    case "turbo":
      cost = 0.0000015;
      break;
    case "claude":
      cost = 0.00001102;
      break;
  }
  return cost * tokens;
}

export function prettyTokens(tokens: number): string {
  if (tokens < 1000) {
    return tokens.toString();
  } else if (tokens < 1000000) {
    return (tokens / 1000).toFixed(1) + "k";
  } else if (tokens < 1000000000) {
    return (tokens / 1000000).toFixed(2) + "m";
  } else {
    return (tokens / 1000000000).toFixed(2) + "b";
  }
}
