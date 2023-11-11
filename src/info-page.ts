import fs from "fs";
import { Request, Response } from "express";
import showdown from "showdown";
import { config, listConfig } from "./config";
import {
  AnthropicKey,
  GooglePalmKey,
  OpenAIKey,
  AwsBedrockKey,
  keyPool,
} from "./shared/key-management";
import { ModelFamily, OpenAIModelFamily } from "./shared/models";
import { getUniqueIps } from "./proxy/rate-limit";
import { getEstimatedWaitTime, getQueueLength } from "./proxy/queue";
import { getTokenCostUsd, prettyTokens } from "./shared/stats";
import { assertNever } from "./shared/utils";

const INFO_PAGE_TTL = 2000;
let infoPageHtml: string | undefined;
let infoPageLastUpdated = 0;

type KeyPoolKey = ReturnType<typeof keyPool.list>[0];
const keyIsOpenAIKey = (k: KeyPoolKey): k is OpenAIKey =>
  k.service === "openai";
const keyIsAnthropicKey = (k: KeyPoolKey): k is AnthropicKey =>
  k.service === "anthropic";
const keyIsGooglePalmKey = (k: KeyPoolKey): k is GooglePalmKey =>
  k.service === "google-palm";
const keyIsAwsKey = (k: KeyPoolKey): k is AwsBedrockKey => k.service === "aws";

type ModelAggregates = {
  active: number;
  trial?: number;
  revoked?: number;
  overQuota?: number;
  pozzed?: number;
  awsLogged?: number;
  queued: number;
  queueTime: string;
  tokens: number;
};
type ModelAggregateKey = `${ModelFamily}__${keyof ModelAggregates}`;
type ServiceAggregates = {
  status?: string;
  openaiKeys?: number;
  openaiOrgs?: number;
  anthropicKeys?: number;
  palmKeys?: number;
  awsKeys?: number;
  proompts: number;
  tokens: number;
  tokenCost: number;
  openAiUncheckedKeys?: number;
  anthropicUncheckedKeys?: number;
} & {
  [modelFamily in ModelFamily]?: ModelAggregates;
};

const modelStats = new Map<ModelAggregateKey, number>();
const serviceStats = new Map<keyof ServiceAggregates, number>();

export const handleInfoPage = (req: Request, res: Response) => {
  if (infoPageLastUpdated + INFO_PAGE_TTL > Date.now()) {
    res.send(infoPageHtml);
    return;
  }

  // Sometimes huggingface doesn't send the host header and makes us guess.
  const baseUrl =
    process.env.SPACE_ID && !req.get("host")?.includes("hf.space")
      ? getExternalUrlForHuggingfaceSpaceId(process.env.SPACE_ID)
      : req.protocol + "://" + req.get("host");

  res.send(cacheInfoPageHtml(baseUrl));
};

function getCostString(cost: number) {
  if (!config.showTokenCosts) return "";
  return ` ($${cost.toFixed(2)})`;
}

function cacheInfoPageHtml(baseUrl: string) {
  const keys = keyPool.list();

  modelStats.clear();
  serviceStats.clear();
  keys.forEach(addKeyToAggregates);

  const openaiKeys = serviceStats.get("openaiKeys") || 0;
  const anthropicKeys = serviceStats.get("anthropicKeys") || 0;
  const palmKeys = serviceStats.get("palmKeys") || 0;
  const awsKeys = serviceStats.get("awsKeys") || 0;
  const proompts = serviceStats.get("proompts") || 0;
  const tokens = serviceStats.get("tokens") || 0;
  const tokenCost = serviceStats.get("tokenCost") || 0;

  const info = {
    uptime: Math.floor(process.uptime()),
    endpoints: {
      ...(openaiKeys ? { openai: baseUrl + "/proxy/openai" } : {}),
      ...(openaiKeys
        ? { ["openai2"]: baseUrl + "/proxy/openai/turbo-instruct" }
        : {}),
      ...(anthropicKeys ? { anthropic: baseUrl + "/proxy/anthropic" } : {}),
      ...(palmKeys ? { "google-palm": baseUrl + "/proxy/google-palm" } : {}),
      ...(awsKeys ? { aws: baseUrl + "/proxy/aws/claude" } : {}),
    },
    proompts,
    tookens: `${prettyTokens(tokens)}${getCostString(tokenCost)}`,
    ...(config.modelRateLimit ? { proomptersNow: getUniqueIps() } : {}),
    openaiKeys,
    anthropicKeys,
    palmKeys,
    awsKeys,
    ...(openaiKeys ? getOpenAIInfo() : {}),
    ...(anthropicKeys ? getAnthropicInfo() : {}),
    ...(palmKeys ? { "palm-bison": getPalmInfo() } : {}),
    ...(awsKeys ? { "aws-claude": getAwsInfo() } : {}),
    config: listConfig(),
    build: process.env.BUILD_INFO || "dev",
  };

  const title = getServerTitle();
  const headerHtml = buildInfoPageHeader(new showdown.Converter(), title);

  const pageBody = `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="robots" content="noindex" />
    <title>${title}</title>
  </head>
  <body style="font-family: sans-serif; background-color: #f0f0f0; padding: 1em;">
    ${headerHtml}
    <hr />
    <h2>Service Info</h2>
    <pre>${JSON.stringify(info, null, 2)}</pre>
    ${getSelfServiceLinks()}
  </body>
</html>`;

  infoPageHtml = pageBody;
  infoPageLastUpdated = Date.now();

  return pageBody;
}

function getUniqueOpenAIOrgs(keys: KeyPoolKey[]) {
  const orgIds = new Set(
    keys.filter((k) => k.service === "openai").map((k: any) => k.organizationId)
  );
  return orgIds.size;
}

function increment<T extends keyof ServiceAggregates | ModelAggregateKey>(
  map: Map<T, number>,
  key: T,
  delta = 1
) {
  map.set(key, (map.get(key) || 0) + delta);
}

function addKeyToAggregates(k: KeyPoolKey) {
  increment(serviceStats, "proompts", k.promptCount);
  increment(serviceStats, "openaiKeys", k.service === "openai" ? 1 : 0);
  increment(serviceStats, "anthropicKeys", k.service === "anthropic" ? 1 : 0);
  increment(serviceStats, "palmKeys", k.service === "google-palm" ? 1 : 0);
  increment(serviceStats, "awsKeys", k.service === "aws" ? 1 : 0);

  let sumTokens = 0;
  let sumCost = 0;

  switch (k.service) {
    case "openai":
      if (!keyIsOpenAIKey(k)) throw new Error("Invalid key type");
      increment(
        serviceStats,
        "openAiUncheckedKeys",
        Boolean(k.lastChecked) ? 0 : 1
      );

      // Technically this would not account for keys that have tokens recorded
      // on models they aren't provisioned for, but that would be strange
      k.modelFamilies.forEach((f) => {
        const tokens = k[`${f}Tokens`];
        sumTokens += tokens;
        sumCost += getTokenCostUsd(f, tokens);
        increment(modelStats, `${f}__tokens`, tokens);
        increment(modelStats, `${f}__trial`, k.isTrial ? 1 : 0);
        increment(modelStats, `${f}__revoked`, k.isRevoked ? 1 : 0);
        increment(modelStats, `${f}__overQuota`, k.isOverQuota ? 1 : 0);
        increment(modelStats, `${f}__active`, k.isDisabled ? 0 : 1);
      });
      break;
    case "anthropic": {
      if (!keyIsAnthropicKey(k)) throw new Error("Invalid key type");
      const family = "claude";
      sumTokens += k.claudeTokens;
      sumCost += getTokenCostUsd(family, k.claudeTokens);
      increment(modelStats, `${family}__active`, k.isDisabled ? 0 : 1);
      increment(modelStats, `${family}__revoked`, k.isRevoked ? 1 : 0);
      increment(modelStats, `${family}__tokens`, k.claudeTokens);
      increment(modelStats, `${family}__pozzed`, k.isPozzed ? 1 : 0);
      increment(
        serviceStats,
        "anthropicUncheckedKeys",
        Boolean(k.lastChecked) ? 0 : 1
      );
      break;
    }
    case "google-palm": {
      if (!keyIsGooglePalmKey(k)) throw new Error("Invalid key type");
      const family = "bison";
      sumTokens += k.bisonTokens;
      sumCost += getTokenCostUsd(family, k.bisonTokens);
      increment(modelStats, `${family}__active`, k.isDisabled ? 0 : 1);
      increment(modelStats, `${family}__revoked`, k.isRevoked ? 1 : 0);
      increment(modelStats, `${family}__tokens`, k.bisonTokens);
      break;
    }
    case "aws": {
      if (!keyIsAwsKey(k)) throw new Error("Invalid key type");
      const family = "aws-claude";
      sumTokens += k["aws-claudeTokens"];
      sumCost += getTokenCostUsd(family, k["aws-claudeTokens"]);
      increment(modelStats, `${family}__active`, k.isDisabled ? 0 : 1);
      increment(modelStats, `${family}__revoked`, k.isRevoked ? 1 : 0);
      increment(modelStats, `${family}__tokens`, k["aws-claudeTokens"]);

      // Ignore revoked keys for aws logging stats, but include keys where the
      // logging status is unknown.
      const countAsLogged =
        k.lastChecked && !k.isDisabled && k.awsLoggingStatus !== "disabled";
      increment(modelStats, `${family}__awsLogged`, countAsLogged ? 1 : 0);

      break;
    }
    default:
      assertNever(k.service);
  }

  increment(serviceStats, "tokens", sumTokens);
  increment(serviceStats, "tokenCost", sumCost);
}

function getOpenAIInfo() {
  const info: { status?: string; openaiKeys?: number; openaiOrgs?: number } & {
    [modelFamily in OpenAIModelFamily]?: {
      usage?: string;
      activeKeys: number;
      trialKeys?: number;
      revokedKeys?: number;
      overQuotaKeys?: number;
      proomptersInQueue?: number;
      estimatedQueueTime?: string;
    };
  } = {};

  const keys = keyPool.list().filter(keyIsOpenAIKey);
  const enabledFamilies = new Set(config.allowedModelFamilies);
  const accessibleFamilies = keys
    .flatMap((k) => k.modelFamilies)
    .filter((f) => enabledFamilies.has(f))
    .concat("turbo");
  const familySet = new Set(accessibleFamilies);

  if (config.checkKeys) {
    const unchecked = serviceStats.get("openAiUncheckedKeys") || 0;
    if (unchecked > 0) {
      info.status = `Checking ${unchecked} keys...`;
    }
    info.openaiKeys = keys.length;
    info.openaiOrgs = getUniqueOpenAIOrgs(keys);

    familySet.forEach((f) => {
      const tokens = modelStats.get(`${f}__tokens`) || 0;
      const cost = getTokenCostUsd(f, tokens);

      info[f] = {
        usage: `${prettyTokens(tokens)} tokens${getCostString(cost)}`,
        activeKeys: modelStats.get(`${f}__active`) || 0,
        trialKeys: modelStats.get(`${f}__trial`) || 0,
        revokedKeys: modelStats.get(`${f}__revoked`) || 0,
        overQuotaKeys: modelStats.get(`${f}__overQuota`) || 0,
      };

      // Don't show trial/revoked keys for non-turbo families.
      // Generally those stats only make sense for the lowest-tier model.
      if (f !== "turbo") {
        console.log("deleting", f);
        delete info[f]!.trialKeys;
        delete info[f]!.revokedKeys;
      }
    });
  } else {
    info.status = "Key checking is disabled.";
    info.turbo = { activeKeys: keys.filter((k) => !k.isDisabled).length };
    info.gpt4 = {
      activeKeys: keys.filter(
        (k) => !k.isDisabled && k.modelFamilies.includes("gpt4")
      ).length,
    };
  }

  familySet.forEach((f) => {
    if (enabledFamilies.has(f)) {
      if (!info[f]) info[f] = { activeKeys: 0 }; // may occur if checkKeys is disabled
      const { estimatedQueueTime, proomptersInQueue } = getQueueInformation(f);
      info[f]!.proomptersInQueue = proomptersInQueue;
      info[f]!.estimatedQueueTime = estimatedQueueTime;
    } else {
      (info[f]! as any).status = "GPT-3.5-Turbo is disabled on this proxy.";
    }
  });

  return info;
}

function getAnthropicInfo() {
  const claudeInfo: Partial<ModelAggregates> = {
    active: modelStats.get("claude__active") || 0,
    pozzed: modelStats.get("claude__pozzed") || 0,
    revoked: modelStats.get("claude__revoked") || 0,
  };

  const queue = getQueueInformation("claude");
  claudeInfo.queued = queue.proomptersInQueue;
  claudeInfo.queueTime = queue.estimatedQueueTime;

  const tokens = modelStats.get("claude__tokens") || 0;
  const cost = getTokenCostUsd("claude", tokens);

  const unchecked =
    (config.checkKeys && serviceStats.get("anthropicUncheckedKeys")) || 0;

  return {
    claude: {
      usage: `${prettyTokens(tokens)} tokens${getCostString(cost)}`,
      ...(unchecked > 0 ? { status: `Checking ${unchecked} keys...` } : {}),
      activeKeys: claudeInfo.active,
      revokedKeys: claudeInfo.revoked,
      ...(config.checkKeys ? { pozzedKeys: claudeInfo.pozzed } : {}),
      proomptersInQueue: claudeInfo.queued,
      estimatedQueueTime: claudeInfo.queueTime,
    },
  };
}

function getPalmInfo() {
  const bisonInfo: Partial<ModelAggregates> = {
    active: modelStats.get("bison__active") || 0,
    revoked: modelStats.get("bison__revoked") || 0,
  };

  const queue = getQueueInformation("bison");
  bisonInfo.queued = queue.proomptersInQueue;
  bisonInfo.queueTime = queue.estimatedQueueTime;

  const tokens = modelStats.get("bison__tokens") || 0;
  const cost = getTokenCostUsd("bison", tokens);

  return {
    usage: `${prettyTokens(tokens)} tokens${getCostString(cost)}`,
    activeKeys: bisonInfo.active,
    revokedKeys: bisonInfo.revoked,
    proomptersInQueue: bisonInfo.queued,
    estimatedQueueTime: bisonInfo.queueTime,
  };
}

function getAwsInfo() {
  const awsInfo: Partial<ModelAggregates> = {
    active: modelStats.get("aws-claude__active") || 0,
    revoked: modelStats.get("aws-claude__revoked") || 0,
  };

  const queue = getQueueInformation("aws-claude");
  awsInfo.queued = queue.proomptersInQueue;
  awsInfo.queueTime = queue.estimatedQueueTime;

  const tokens = modelStats.get("aws-claude__tokens") || 0;
  const cost = getTokenCostUsd("aws-claude", tokens);

  const logged = modelStats.get("aws-claude__awsLogged") || 0;
  const logMsg = config.allowAwsLogging
    ? `${logged} active keys are potentially logged.`
    : `${logged} active keys are potentially logged and can't be used. Set ALLOW_AWS_LOGGING=true to override.`;

  return {
    usage: `${prettyTokens(tokens)} tokens${getCostString(cost)}`,
    activeKeys: awsInfo.active,
    revokedKeys: awsInfo.revoked,
    proomptersInQueue: awsInfo.queued,
    estimatedQueueTime: awsInfo.queueTime,
    ...(logged > 0 ? { privacy: logMsg } : {}),
  };
}

const customGreeting = fs.existsSync("greeting.md")
  ? fs.readFileSync("greeting.md", "utf8")
  : null;

/**
 * If the server operator provides a `greeting.md` file, it will be included in
 * the rendered info page.
 **/
function buildInfoPageHeader(converter: showdown.Converter, title: string) {
  // TODO: use some templating engine instead of this mess
  let infoBody = `<!-- Header for Showdown's parser, don't remove this line -->
# ${title}`;
  if (config.promptLogging) {
    infoBody += `\n## Prompt logging is enabled!
The server operator has enabled prompt logging. The prompts you send to this proxy and the AI responses you receive may be saved.

Logs are anonymous and do not contain IP addresses or timestamps. [You can see the type of data logged here, along with the rest of the code.](https://gitgud.io/khanon/oai-reverse-proxy/-/blob/main/src/prompt-logging/index.ts).

**If you are uncomfortable with this, don't send prompts to this proxy!**`;
  }

  const waits: string[] = [];
  infoBody += `\n## Estimated Wait Times\nIf the AI is busy, your prompt will processed when a slot frees up.`;

  if (config.openaiKey) {
    // TODO: un-fuck this
    const keys = keyPool.list().filter((k) => k.service === "openai");

    const turboWait = getQueueInformation("turbo").estimatedQueueTime;
    waits.push(`**Turbo:** ${turboWait}`);

    const gpt4Wait = getQueueInformation("gpt4").estimatedQueueTime;
    const hasGpt4 = keys.some((k) => k.modelFamilies.includes("gpt4"));
    const allowedGpt4 = config.allowedModelFamilies.includes("gpt4");
    if (hasGpt4 && allowedGpt4) {
      waits.push(`**GPT-4:** ${gpt4Wait}`);
    }

    const gpt432kWait = getQueueInformation("gpt4-32k").estimatedQueueTime;
    const hasGpt432k = keys.some((k) => k.modelFamilies.includes("gpt4-32k"));
    const allowedGpt432k = config.allowedModelFamilies.includes("gpt4-32k");
    if (hasGpt432k && allowedGpt432k) {
      waits.push(`**GPT-4-32k:** ${gpt432kWait}`);
    }
  }

  if (config.anthropicKey) {
    const claudeWait = getQueueInformation("claude").estimatedQueueTime;
    waits.push(`**Claude:** ${claudeWait}`);
  }

  if (config.awsCredentials) {
    const awsClaudeWait = getQueueInformation("aws-claude").estimatedQueueTime;
    waits.push(`**Claude (AWS):** ${awsClaudeWait}`);
  }

  infoBody += "\n\n" + waits.join(" / ");

  if (customGreeting) {
    infoBody += `\n## Server Greeting\n${customGreeting}`;
  }
  return converter.makeHtml(infoBody);
}

function getSelfServiceLinks() {
  if (config.gatekeeper !== "user_token") return "";
  return `<footer style="font-size: 0.8em;"><hr /><a target="_blank" href="/user/lookup">Check your user token info</a></footer>`;
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

function getServerTitle() {
  // Use manually set title if available
  if (process.env.SERVER_TITLE) {
    return process.env.SERVER_TITLE;
  }

  // Huggingface
  if (process.env.SPACE_ID) {
    return `${process.env.SPACE_AUTHOR_NAME} / ${process.env.SPACE_TITLE}`;
  }

  // Render
  if (process.env.RENDER) {
    return `Render / ${process.env.RENDER_SERVICE_NAME}`;
  }

  return "OAI Reverse Proxy";
}

function getExternalUrlForHuggingfaceSpaceId(spaceId: string) {
  // Huggingface broke their amazon elb config and no longer sends the
  // x-forwarded-host header. This is a workaround.
  try {
    const [username, spacename] = spaceId.split("/");
    return `https://${username}-${spacename.replace(/_/g, "-")}.hf.space`;
  } catch (e) {
    return "";
  }
}
