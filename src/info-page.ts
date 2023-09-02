import fs from "fs";
import { Request, Response } from "express";
import showdown from "showdown";
import { config, listConfig } from "./config";
import { AnthropicKey, OpenAIKey, keyPool } from "./shared/key-management";
import { ModelFamily, OpenAIModelFamily } from "./shared/models";
import { getUniqueIps } from "./proxy/rate-limit";
import { getEstimatedWaitTime, getQueueLength } from "./proxy/queue";
import { logger } from "./logger";
import { getTokenCostUsd, prettyTokens } from "./shared/stats";

const INFO_PAGE_TTL = 2000;
let infoPageHtml: string | undefined;
let infoPageLastUpdated = 0;

type KeyPoolKey = ReturnType<typeof keyPool.list>[0];
const keyIsOpenAIKey = (k: KeyPoolKey): k is OpenAIKey =>
  k.service === "openai";
const keyIsAnthropicKey = (k: KeyPoolKey): k is AnthropicKey =>
  k.service === "anthropic";

type ModelAggregates = {
  active: number;
  trial?: number;
  revoked?: number;
  overQuota?: number;
  pozzed?: number;
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
  const proompts = serviceStats.get("proompts") || 0;
  const tokens = serviceStats.get("tokens") || 0;
  const tokenCost = serviceStats.get("tokenCost") || 0;

  const info = {
    uptime: Math.floor(process.uptime()),
    endpoints: {
      ...(openaiKeys ? { openai: baseUrl + "/proxy/openai" } : {}),
      ...(anthropicKeys ? { anthropic: baseUrl + "/proxy/anthropic" } : {}),
    },
    proompts,
    ...(config.showTokenCosts
      ? { tookens: `${prettyTokens(tokens)}${getCostString(tokenCost)}` }
      : { tookens: tokens }),
    ...(config.modelRateLimit ? { proomptersNow: getUniqueIps() } : {}),
    openaiKeys,
    anthropicKeys,
    ...(openaiKeys ? getOpenAIInfo() : {}),
    ...(anthropicKeys ? getAnthropicInfo() : {}),
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

  let sumTokens = 0;
  let sumCost = 0;
  let family: ModelFamily;
  const families = k.modelFamilies.filter((f) =>
    config.allowedModelFamilies.includes(f)
  );

  if (keyIsOpenAIKey(k)) {
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
    });

    if (families.includes("gpt4-32k")) {
      family = "gpt4-32k";
    } else if (families.includes("gpt4")) {
      family = "gpt4";
    } else {
      family = "turbo";
    }
  } else if (keyIsAnthropicKey(k)) {
    const tokens = k.claudeTokens;
    family = "claude";
    sumTokens += tokens;
    sumCost += getTokenCostUsd(family, tokens);
    increment(modelStats, `${family}__tokens`, tokens);
    increment(modelStats, `${family}__pozzed`, k.isPozzed ? 1 : 0);
    increment(
      serviceStats,
      "anthropicUncheckedKeys",
      Boolean(k.lastChecked) ? 0 : 1
    );
  } else {
    logger.error({ key: k.hash }, "Unknown key type when adding to aggregates");
    return;
  }

  increment(serviceStats, "tokens", sumTokens);
  increment(serviceStats, "tokenCost", sumCost);
  increment(modelStats, `${family}__active`, k.isDisabled ? 0 : 1);
  increment(modelStats, `${family}__trial`, k.isTrial ? 1 : 0);
  if ("isRevoked" in k) {
    increment(modelStats, `${family}__revoked`, k.isRevoked ? 1 : 0);
  }
  if ("isOverQuota" in k) {
    increment(modelStats, `${family}__overQuota`, k.isOverQuota ? 1 : 0);
  }
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

  const allowedFamilies = new Set(config.allowedModelFamilies);
  let families = new Set<OpenAIModelFamily>();
  const keys = keyPool.list().filter((k) => {
    const isOpenAI = keyIsOpenAIKey(k);
    if (isOpenAI) k.modelFamilies.forEach((f) => families.add(f));
    return isOpenAI;
  }) as Omit<OpenAIKey, "key">[];
  families = new Set([...families].filter((f) => allowedFamilies.has(f)));

  if (config.checkKeys) {
    const unchecked = serviceStats.get("openAiUncheckedKeys") || 0;
    if (unchecked > 0) {
      info.status = `Checking ${unchecked} keys...`;
    }
    info.openaiKeys = keys.length;
    info.openaiOrgs = getUniqueOpenAIOrgs(keys);

    families.forEach((f) => {
      const tokens = modelStats.get(`${f}__tokens`) || 0;
      const cost = getTokenCostUsd(f, tokens);

      info[f] = {
        usage: `${prettyTokens(tokens)} tokens${getCostString(cost)}`,
        activeKeys: modelStats.get(`${f}__active`) || 0,
        trialKeys: modelStats.get(`${f}__trial`) || 0,
        revokedKeys: modelStats.get(`${f}__revoked`) || 0,
        overQuotaKeys: modelStats.get(`${f}__overQuota`) || 0,
      };
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

  families.forEach((f) => {
    if (info[f]) {
      const { estimatedQueueTime, proomptersInQueue } = getQueueInformation(f);
      info[f]!.proomptersInQueue = proomptersInQueue;
      info[f]!.estimatedQueueTime = estimatedQueueTime;
    }
  });

  return info;
}

function getAnthropicInfo() {
  const claudeInfo: Partial<ModelAggregates> = {
    active: modelStats.get("claude__active") || 0,
    pozzed: modelStats.get("claude__pozzed") || 0,
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
      ...(config.checkKeys ? { pozzedKeys: claudeInfo.pozzed } : {}),
      proomptersInQueue: claudeInfo.queued,
      estimatedQueueTime: claudeInfo.queueTime,
    },
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
