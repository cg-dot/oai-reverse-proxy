import { config, listConfig } from "./config";
import {
  AnthropicKey,
  AwsBedrockKey,
  AzureOpenAIKey,
  GoogleAIKey,
  keyPool,
  OpenAIKey,
} from "./shared/key-management";
import {
  AnthropicModelFamily,
  assertIsKnownModelFamily,
  AwsBedrockModelFamily,
  AzureOpenAIModelFamily,
  GoogleAIModelFamily,
  LLM_SERVICES,
  LLMService,
  MistralAIModelFamily,
  MODEL_FAMILY_SERVICE,
  ModelFamily,
  OpenAIModelFamily,
} from "./shared/models";
import { getCostSuffix, getTokenCostUsd, prettyTokens } from "./shared/stats";
import { getUniqueIps } from "./proxy/rate-limit";
import { assertNever } from "./shared/utils";
import { getEstimatedWaitTime, getQueueLength } from "./proxy/queue";
import { MistralAIKey } from "./shared/key-management/mistral-ai/provider";

const CACHE_TTL = 2000;

type KeyPoolKey = ReturnType<typeof keyPool.list>[0];
const keyIsOpenAIKey = (k: KeyPoolKey): k is OpenAIKey =>
  k.service === "openai";
const keyIsAzureKey = (k: KeyPoolKey): k is AzureOpenAIKey =>
  k.service === "azure";
const keyIsAnthropicKey = (k: KeyPoolKey): k is AnthropicKey =>
  k.service === "anthropic";
const keyIsGoogleAIKey = (k: KeyPoolKey): k is GoogleAIKey =>
  k.service === "google-ai";
const keyIsMistralAIKey = (k: KeyPoolKey): k is MistralAIKey =>
  k.service === "mistral-ai";
const keyIsAwsKey = (k: KeyPoolKey): k is AwsBedrockKey => k.service === "aws";

/** Stats aggregated across all keys for a given service. */
type ServiceAggregate = "keys" | "uncheckedKeys" | "orgs";
/** Stats aggregated across all keys for a given model family. */
type ModelAggregates = {
  active: number;
  trial?: number;
  revoked?: number;
  overQuota?: number;
  pozzed?: number;
  awsLogged?: number;
  awsSonnet?: number;
  awsHaiku?: number;
  queued: number;
  queueTime: string;
  tokens: number;
};
/** All possible combinations of model family and aggregate type. */
type ModelAggregateKey = `${ModelFamily}__${keyof ModelAggregates}`;

type AllStats = {
  proompts: number;
  tokens: number;
  tokenCost: number;
} & { [modelFamily in ModelFamily]?: ModelAggregates } & {
  [service in LLMService as `${service}__${ServiceAggregate}`]?: number;
};

type BaseFamilyInfo = {
  usage?: string;
  activeKeys: number;
  revokedKeys?: number;
  proomptersInQueue?: number;
  estimatedQueueTime?: string;
};
type OpenAIInfo = BaseFamilyInfo & {
  trialKeys?: number;
  overQuotaKeys?: number;
};
type AnthropicInfo = BaseFamilyInfo & {
  trialKeys?: number;
  prefilledKeys?: number;
  overQuotaKeys?: number;
};
type AwsInfo = BaseFamilyInfo & {
  privacy?: string;
  sonnetKeys?: number;
  haikuKeys?: number;
};

// prettier-ignore
export type ServiceInfo = {
  uptime: number;
  endpoints: {
    openai?: string;
    openai2?: string;
    anthropic?: string;
    "anthropic-claude-3"?: string;
    "google-ai"?: string;
    "mistral-ai"?: string;
    aws?: string;
    azure?: string;
    "openai-image"?: string;
    "azure-image"?: string;
  };
  proompts?: number;
  tookens?: string;
  proomptersNow?: number;
  status?: string;
  config: ReturnType<typeof listConfig>;
  build: string;
} & { [f in OpenAIModelFamily]?: OpenAIInfo }
  & { [f in AnthropicModelFamily]?: AnthropicInfo; }
  & { [f in AwsBedrockModelFamily]?: AwsInfo }
  & { [f in AzureOpenAIModelFamily]?: BaseFamilyInfo; }
  & { [f in GoogleAIModelFamily]?: BaseFamilyInfo }
  & { [f in MistralAIModelFamily]?: BaseFamilyInfo };

// https://stackoverflow.com/a/66661477
// type DeepKeyOf<T> = (
//   [T] extends [never]
//     ? ""
//     : T extends object
//     ? {
//         [K in Exclude<keyof T, symbol>]: `${K}${DotPrefix<DeepKeyOf<T[K]>>}`;
//       }[Exclude<keyof T, symbol>]
//     : ""
// ) extends infer D
//   ? Extract<D, string>
//   : never;
// type DotPrefix<T extends string> = T extends "" ? "" : `.${T}`;
// type ServiceInfoPath = `{${DeepKeyOf<ServiceInfo>}}`;

const SERVICE_ENDPOINTS: { [s in LLMService]: Record<string, string> } = {
  openai: {
    openai: `%BASE%/openai`,
    openai2: `%BASE%/openai/turbo-instruct`,
    "openai-image": `%BASE%/openai-image`,
  },
  anthropic: {
    anthropic: `%BASE%/anthropic`,
  },
  "google-ai": {
    "google-ai": `%BASE%/google-ai`,
  },
  "mistral-ai": {
    "mistral-ai": `%BASE%/mistral-ai`,
  },
  aws: {
    aws: `%BASE%/aws/claude`,
  },
  azure: {
    azure: `%BASE%/azure/openai`,
    "azure-image": `%BASE%/azure/openai`,
  },
};

const modelStats = new Map<ModelAggregateKey, number>();
const serviceStats = new Map<keyof AllStats, number>();

let cachedInfo: ServiceInfo | undefined;
let cacheTime = 0;

export function buildInfo(baseUrl: string, forAdmin = false): ServiceInfo {
  if (cacheTime + CACHE_TTL > Date.now()) return cachedInfo!;

  const keys = keyPool.list();
  const accessibleFamilies = new Set(
    keys
      .flatMap((k) => k.modelFamilies)
      .filter((f) => config.allowedModelFamilies.includes(f))
      .concat("turbo")
  );

  modelStats.clear();
  serviceStats.clear();
  keys.forEach(addKeyToAggregates);

  const endpoints = getEndpoints(baseUrl, accessibleFamilies);
  const trafficStats = getTrafficStats();
  const { serviceInfo, modelFamilyInfo } =
    getServiceModelStats(accessibleFamilies);
  const status = getStatus();

  if (config.staticServiceInfo && !forAdmin) {
    delete trafficStats.proompts;
    delete trafficStats.tookens;
    delete trafficStats.proomptersNow;
    for (const family of Object.keys(modelFamilyInfo)) {
      assertIsKnownModelFamily(family);
      delete modelFamilyInfo[family]?.proomptersInQueue;
      delete modelFamilyInfo[family]?.estimatedQueueTime;
      delete modelFamilyInfo[family]?.usage;
    }
  }

  return (cachedInfo = {
    uptime: Math.floor(process.uptime()),
    endpoints,
    ...trafficStats,
    ...serviceInfo,
    status,
    ...modelFamilyInfo,
    config: listConfig(),
    build: process.env.BUILD_INFO || "dev",
  });
}

function getStatus() {
  if (!config.checkKeys)
    return "Key checking is disabled. The data displayed are not reliable.";

  let unchecked = 0;
  for (const service of LLM_SERVICES) {
    unchecked += serviceStats.get(`${service}__uncheckedKeys`) || 0;
  }

  return unchecked ? `Checking ${unchecked} keys...` : undefined;
}

function getEndpoints(baseUrl: string, accessibleFamilies: Set<ModelFamily>) {
  const endpoints: Record<string, string> = {};
  const keys = keyPool.list();
  for (const service of LLM_SERVICES) {
    if (!keys.some((k) => k.service === service)) {
      continue;
    }

    for (const [name, url] of Object.entries(SERVICE_ENDPOINTS[service])) {
      endpoints[name] = url.replace("%BASE%", baseUrl);
    }

    if (service === "openai" && !accessibleFamilies.has("dall-e")) {
      delete endpoints["openai-image"];
    }

    if (service === "azure" && !accessibleFamilies.has("azure-dall-e")) {
      delete endpoints["azure-image"];
    }
  }
  return endpoints;
}

type TrafficStats = Pick<ServiceInfo, "proompts" | "tookens" | "proomptersNow">;

function getTrafficStats(): TrafficStats {
  const tokens = serviceStats.get("tokens") || 0;
  const tokenCost = serviceStats.get("tokenCost") || 0;
  return {
    proompts: serviceStats.get("proompts") || 0,
    tookens: `${prettyTokens(tokens)}${getCostSuffix(tokenCost)}`,
    ...(config.textModelRateLimit ? { proomptersNow: getUniqueIps() } : {}),
  };
}

function getServiceModelStats(accessibleFamilies: Set<ModelFamily>) {
  const serviceInfo: {
    [s in LLMService as `${s}${"Keys" | "Orgs"}`]?: number;
  } = {};
  const modelFamilyInfo: { [f in ModelFamily]?: BaseFamilyInfo } = {};

  for (const service of LLM_SERVICES) {
    const hasKeys = serviceStats.get(`${service}__keys`) || 0;
    if (!hasKeys) continue;

    serviceInfo[`${service}Keys`] = hasKeys;
    accessibleFamilies.forEach((f) => {
      if (MODEL_FAMILY_SERVICE[f] === service) {
        modelFamilyInfo[f] = getInfoForFamily(f);
      }
    });

    if (service === "openai" && config.checkKeys) {
      serviceInfo.openaiOrgs = getUniqueOpenAIOrgs(keyPool.list());
    }
  }
  return { serviceInfo, modelFamilyInfo };
}

function getUniqueOpenAIOrgs(keys: KeyPoolKey[]) {
  const orgIds = new Set(
    keys.filter((k) => k.service === "openai").map((k: any) => k.organizationId)
  );
  return orgIds.size;
}

function increment<T extends keyof AllStats | ModelAggregateKey>(
  map: Map<T, number>,
  key: T,
  delta = 1
) {
  map.set(key, (map.get(key) || 0) + delta);
}

function addKeyToAggregates(k: KeyPoolKey) {
  increment(serviceStats, "proompts", k.promptCount);
  increment(serviceStats, "openai__keys", k.service === "openai" ? 1 : 0);
  increment(serviceStats, "anthropic__keys", k.service === "anthropic" ? 1 : 0);
  increment(serviceStats, "google-ai__keys", k.service === "google-ai" ? 1 : 0);
  increment(
    serviceStats,
    "mistral-ai__keys",
    k.service === "mistral-ai" ? 1 : 0
  );
  increment(serviceStats, "aws__keys", k.service === "aws" ? 1 : 0);
  increment(serviceStats, "azure__keys", k.service === "azure" ? 1 : 0);

  let sumTokens = 0;
  let sumCost = 0;

  switch (k.service) {
    case "openai":
      if (!keyIsOpenAIKey(k)) throw new Error("Invalid key type");
      increment(
        serviceStats,
        "openai__uncheckedKeys",
        Boolean(k.lastChecked) ? 0 : 1
      );

      k.modelFamilies.forEach((f) => {
        const tokens = k[`${f}Tokens`];
        sumTokens += tokens;
        sumCost += getTokenCostUsd(f, tokens);
        increment(modelStats, `${f}__tokens`, tokens);
        increment(modelStats, `${f}__revoked`, k.isRevoked ? 1 : 0);
        increment(modelStats, `${f}__active`, k.isDisabled ? 0 : 1);
        increment(modelStats, `${f}__trial`, k.isTrial ? 1 : 0);
        increment(modelStats, `${f}__overQuota`, k.isOverQuota ? 1 : 0);
      });
      break;
    case "azure":
      if (!keyIsAzureKey(k)) throw new Error("Invalid key type");
      k.modelFamilies.forEach((f) => {
        const tokens = k[`${f}Tokens`];
        sumTokens += tokens;
        sumCost += getTokenCostUsd(f, tokens);
        increment(modelStats, `${f}__tokens`, tokens);
        increment(modelStats, `${f}__active`, k.isDisabled ? 0 : 1);
        increment(modelStats, `${f}__revoked`, k.isRevoked ? 1 : 0);
      });
      break;
    case "anthropic": {
      if (!keyIsAnthropicKey(k)) throw new Error("Invalid key type");
      k.modelFamilies.forEach((f) => {
        const tokens = k[`${f}Tokens`];
        sumTokens += tokens;
        sumCost += getTokenCostUsd(f, tokens);
        increment(modelStats, `${f}__tokens`, tokens);
        increment(modelStats, `${f}__trial`, k.tier === "free" ? 1 : 0);
        increment(modelStats, `${f}__revoked`, k.isRevoked ? 1 : 0);
        increment(modelStats, `${f}__active`, k.isDisabled ? 0 : 1);
        increment(modelStats, `${f}__overQuota`, k.isOverQuota ? 1 : 0);
        increment(modelStats, `${f}__pozzed`, k.isPozzed ? 1 : 0);
      });
      increment(
        serviceStats,
        "anthropic__uncheckedKeys",
        Boolean(k.lastChecked) ? 0 : 1
      );
      break;
    }
    case "google-ai": {
      if (!keyIsGoogleAIKey(k)) throw new Error("Invalid key type");
      const family = "gemini-pro";
      sumTokens += k["gemini-proTokens"];
      sumCost += getTokenCostUsd(family, k["gemini-proTokens"]);
      increment(modelStats, `${family}__active`, k.isDisabled ? 0 : 1);
      increment(modelStats, `${family}__revoked`, k.isRevoked ? 1 : 0);
      increment(modelStats, `${family}__tokens`, k["gemini-proTokens"]);
      break;
    }
    case "mistral-ai": {
      if (!keyIsMistralAIKey(k)) throw new Error("Invalid key type");
      k.modelFamilies.forEach((f) => {
        const tokens = k[`${f}Tokens`];
        sumTokens += tokens;
        sumCost += getTokenCostUsd(f, tokens);
        increment(modelStats, `${f}__tokens`, tokens);
        increment(modelStats, `${f}__revoked`, k.isRevoked ? 1 : 0);
        increment(modelStats, `${f}__active`, k.isDisabled ? 0 : 1);
      });
      break;
    }
    case "aws": {
      if (!keyIsAwsKey(k)) throw new Error("Invalid key type");
      k.modelFamilies.forEach((f) => {
        const tokens = k[`${f}Tokens`];
        sumTokens += tokens;
        sumCost += getTokenCostUsd(f, tokens);
        increment(modelStats, `${f}__tokens`, tokens);
        increment(modelStats, `${f}__revoked`, k.isRevoked ? 1 : 0);
        increment(modelStats, `${f}__active`, k.isDisabled ? 0 : 1);
      });
      increment(modelStats, `aws-claude__awsSonnet`, k.sonnetEnabled ? 1 : 0);
      increment(modelStats, `aws-claude__awsHaiku`, k.haikuEnabled ? 1 : 0);

      // Ignore revoked keys for aws logging stats, but include keys where the
      // logging status is unknown.
      const countAsLogged =
        k.lastChecked && !k.isDisabled && k.awsLoggingStatus === "enabled";
      increment(modelStats, `aws-claude__awsLogged`, countAsLogged ? 1 : 0);
      break;
    }
    default:
      assertNever(k.service);
  }

  increment(serviceStats, "tokens", sumTokens);
  increment(serviceStats, "tokenCost", sumCost);
}

function getInfoForFamily(family: ModelFamily): BaseFamilyInfo {
  const tokens = modelStats.get(`${family}__tokens`) || 0;
  const cost = getTokenCostUsd(family, tokens);
  let info: BaseFamilyInfo & OpenAIInfo & AnthropicInfo & AwsInfo = {
    usage: `${prettyTokens(tokens)} tokens${getCostSuffix(cost)}`,
    activeKeys: modelStats.get(`${family}__active`) || 0,
    revokedKeys: modelStats.get(`${family}__revoked`) || 0,
  };

  // Add service-specific stats to the info object.
  if (config.checkKeys) {
    const service = MODEL_FAMILY_SERVICE[family];
    switch (service) {
      case "openai":
        info.overQuotaKeys = modelStats.get(`${family}__overQuota`) || 0;
        info.trialKeys = modelStats.get(`${family}__trial`) || 0;

        // Delete trial/revoked keys for non-turbo families.
        // Trials are turbo 99% of the time, and if a key is invalid we don't
        // know what models it might have had assigned to it.
        if (family !== "turbo") {
          delete info.trialKeys;
          delete info.revokedKeys;
        }
        break;
      case "anthropic":
        info.overQuotaKeys = modelStats.get(`${family}__overQuota`) || 0;
        info.trialKeys = modelStats.get(`${family}__trial`) || 0;
        info.prefilledKeys = modelStats.get(`${family}__pozzed`) || 0;
        break;
      case "aws":
        if (family === "aws-claude") {
          info.sonnetKeys = modelStats.get(`${family}__awsSonnet`) || 0;
          info.haikuKeys = modelStats.get(`${family}__awsHaiku`) || 0;
          const logged = modelStats.get(`${family}__awsLogged`) || 0;
          if (logged > 0) {
            info.privacy = config.allowAwsLogging
              ? `AWS logging verification inactive. Prompts could be logged.`
              : `${logged} active keys are potentially logged and can't be used. Set ALLOW_AWS_LOGGING=true to override.`;
          }
        }
        break;
    }
  }

  // Add queue stats to the info object.
  const queue = getQueueInformation(family);
  info.proomptersInQueue = queue.proomptersInQueue;
  info.estimatedQueueTime = queue.estimatedQueueTime;

  return info;
}

/** Returns queue time in seconds, or minutes + seconds if over 60 seconds. */
function getQueueInformation(partition: ModelFamily) {
  const waitMs = getEstimatedWaitTime(partition);
  const waitTime =
    waitMs < 60000
      ? `${Math.round(waitMs / 1000)}sec`
      : `${Math.round(waitMs / 60000)}min, ${Math.round(
          (waitMs % 60000) / 1000
        )}sec`;
  return {
    proomptersInQueue: getQueueLength(partition),
    estimatedQueueTime: waitMs > 2000 ? waitTime : "no wait",
  };
}
