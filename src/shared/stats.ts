import { config } from "../config";
import { ModelFamily } from "./models";

// technically slightly underestimates, because completion tokens cost more
// than prompt tokens but we don't track those separately right now
export function getTokenCostUsd(model: ModelFamily, tokens: number) {
  let cost = 0;
  switch (model) {
    case "gpt4o":
    case "azure-gpt4o":
      cost = 0.000005;
      break;
    case "azure-gpt4-turbo":
    case "gpt4-turbo":
      cost = 0.00001;
      break;
    case "azure-gpt4-32k":
    case "gpt4-32k":
      cost = 0.00006;
      break;
    case "azure-gpt4":
    case "gpt4":
      cost = 0.00003;
      break;
    case "azure-turbo":
    case "turbo":
      cost = 0.000001;
      break;
    case "azure-dall-e":
      cost = 0.00001;
      break;
    case "aws-claude":
    case "claude":
      cost = 0.000008;
      break;
    case "aws-claude-opus":
    case "claude-opus":
      cost = 0.000015;
      break;
    case "mistral-tiny":
      cost = 0.00000031;
      break;
    case "mistral-small":
      cost = 0.00000132;
      break;
    case "mistral-medium":
      cost = 0.0000055;
      break;
  }
  return cost * Math.max(0, tokens);
}

export function prettyTokens(tokens: number): string {
  const absTokens = Math.abs(tokens);
  if (absTokens < 1000) {
    return tokens.toString();
  } else if (absTokens < 1000000) {
    return (tokens / 1000).toFixed(1) + "k";
  } else if (absTokens < 1000000000) {
    return (tokens / 1000000).toFixed(2) + "m";
  } else {
    return (tokens / 1000000000).toFixed(3) + "b";
  }
}

export function getCostSuffix(cost: number) {
  if (!config.showTokenCosts) return "";
  return ` ($${cost.toFixed(2)})`;
}
