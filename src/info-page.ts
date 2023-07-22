import fs from "fs";
import { Request, Response } from "express";
import showdown from "showdown";
import { config, listConfig } from "./config";
import { OpenAIKey, keyPool } from "./key-management";
import { getUniqueIps } from "./proxy/rate-limit";
import {
  QueuePartition,
  getEstimatedWaitTime,
  getQueueLength,
} from "./proxy/queue";

const INFO_PAGE_TTL = 5000;
let infoPageHtml: string | undefined;
let infoPageLastUpdated = 0;

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

function cacheInfoPageHtml(baseUrl: string) {
  const keys = keyPool.list();

  const openaiKeys = keys.filter((k) => k.service === "openai").length;
  const anthropicKeys = keys.filter((k) => k.service === "anthropic").length;

  const info = {
    uptime: process.uptime(),
    endpoints: {
      ...(openaiKeys ? { openai: baseUrl + "/proxy/openai" } : {}),
      ...(anthropicKeys ? { anthropic: baseUrl + "/proxy/anthropic" } : {}),
    },
    proompts: keys.reduce((acc, k) => acc + k.promptCount, 0),
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
  </body>
</html>`;

  infoPageHtml = pageBody;
  infoPageLastUpdated = Date.now();

  return pageBody;
}

type ServiceInfo = {
  activeKeys: number;
  trialKeys?: number;
  activeLimit: string;
  revokedKeys?: number;
  overQuotaKeys?: number;
  proomptersInQueue: number;
  estimatedQueueTime: string;
};

// this has long since outgrown this awful "dump everything in a <pre> tag" approach
// but I really don't want to spend time on a proper UI for this right now

function getOpenAIInfo() {
  const info: { [model: string]: Partial<ServiceInfo> } = {};
  const keys = keyPool
    .list()
    .filter((k) => k.service === "openai") as OpenAIKey[];
  const hasGpt4 = keys.some((k) => k.isGpt4) && !config.turboOnly;

  if (keyPool.anyUnchecked()) {
    const uncheckedKeys = keys.filter((k) => !k.lastChecked);
    info.status =
      `Performing startup key checks (${uncheckedKeys.length} left).` as any;
  } else {
    delete info.status;
  }

  if (config.checkKeys) {
    const turboKeys = keys.filter((k) => !k.isGpt4);
    const gpt4Keys = keys.filter((k) => k.isGpt4);

    const quota: Record<string, string> = { turbo: "", gpt4: "" };
    const turboQuota = keyPool.activeLimitInUsd("openai");
    const gpt4Quota = keyPool.activeLimitInUsd("openai", { gpt4: true });

    // Don't invert this condition; some proxies may be using the now-deprecated
    // 'partial' option which we want to treat as 'full' here.
    if (config.quotaDisplayMode !== "none") {
      quota.turbo = turboQuota;
      quota.gpt4 = gpt4Quota;
    }

    info.turbo = {
      activeKeys: turboKeys.filter((k) => !k.isDisabled).length,
      trialKeys: turboKeys.filter((k) => k.isTrial).length,
      activeLimit: quota.turbo,
      revokedKeys: turboKeys.filter((k) => k.isRevoked).length,
      overQuotaKeys: turboKeys.filter((k) => k.isOverQuota).length,
    };

    if (hasGpt4) {
      info.gpt4 = {
        activeKeys: gpt4Keys.filter((k) => !k.isDisabled).length,
        trialKeys: gpt4Keys.filter((k) => k.isTrial).length,
        activeLimit: quota.gpt4,
        revokedKeys: gpt4Keys.filter((k) => k.isRevoked).length,
        overQuotaKeys: gpt4Keys.filter((k) => k.isOverQuota).length,
      };
    }

    if (config.quotaDisplayMode === "none") {
      delete info.turbo?.activeLimit;
      delete info.gpt4?.activeLimit;
    }
  } else {
    info.status = "Key checking is disabled." as any;
    info.turbo = { activeKeys: keys.filter((k) => !k.isDisabled).length };
    info.gpt4 = {
      activeKeys: keys.filter((k) => !k.isDisabled && k.isGpt4).length,
    };
  }

  if (config.queueMode !== "none") {
    const turboQueue = getQueueInformation("turbo");

    info.turbo.proomptersInQueue = turboQueue.proomptersInQueue;
    info.turbo.estimatedQueueTime = turboQueue.estimatedQueueTime;

    if (hasGpt4) {
      const gpt4Queue = getQueueInformation("gpt-4");
      info.gpt4.proomptersInQueue = gpt4Queue.proomptersInQueue;
      info.gpt4.estimatedQueueTime = gpt4Queue.estimatedQueueTime;
    }
  }

  return info;
}

function getAnthropicInfo() {
  const claudeInfo: Partial<ServiceInfo> = {};
  const keys = keyPool.list().filter((k) => k.service === "anthropic");
  claudeInfo.activeKeys = keys.filter((k) => !k.isDisabled).length;
  if (config.queueMode !== "none") {
    const queue = getQueueInformation("claude");
    claudeInfo.proomptersInQueue = queue.proomptersInQueue;
    claudeInfo.estimatedQueueTime = queue.estimatedQueueTime;
  }
  return { claude: claudeInfo };
}

/**
 * If the server operator provides a `greeting.md` file, it will be included in
 * the rendered info page.
 **/
function buildInfoPageHeader(converter: showdown.Converter, title: string) {
  const customGreeting = fs.existsSync("greeting.md")
    ? fs.readFileSync("greeting.md", "utf8")
    : null;

  // TODO: use some templating engine instead of this mess

  let infoBody = `<!-- Header for Showdown's parser, don't remove this line -->
# ${title}`;
  if (config.promptLogging) {
    infoBody += `\n## Prompt logging is enabled!
The server operator has enabled prompt logging. The prompts you send to this proxy and the AI responses you receive may be saved.

Logs are anonymous and do not contain IP addresses or timestamps. [You can see the type of data logged here, along with the rest of the code.](https://gitgud.io/khanon/oai-reverse-proxy/-/blob/main/src/prompt-logging/index.ts).

**If you are uncomfortable with this, don't send prompts to this proxy!**`;
  }

  if (config.queueMode !== "none") {
    const waits: string[] = [];
    infoBody += `\n## Estimated Wait Times\nIf the AI is busy, your prompt will processed when a slot frees up.`;

    if (config.openaiKey) {
      const turboWait = getQueueInformation("turbo").estimatedQueueTime;
      const gpt4Wait = getQueueInformation("gpt-4").estimatedQueueTime;
      waits.push(`**Turbo:** ${turboWait}`);
      if (keyPool.list().some((k) => k.isGpt4) && !config.turboOnly) {
        waits.push(`**GPT-4:** ${gpt4Wait}`);
      }
    }

    if (config.anthropicKey) {
      const claudeWait = getQueueInformation("claude").estimatedQueueTime;
      waits.push(`**Claude:** ${claudeWait}`);
    }
    infoBody += "\n\n" + waits.join(" / ");
  }

  if (customGreeting) {
    infoBody += `\n## Server Greeting\n
${customGreeting}`;
  }
  return converter.makeHtml(infoBody);
}

/** Returns queue time in seconds, or minutes + seconds if over 60 seconds. */
function getQueueInformation(partition: QueuePartition) {
  if (config.queueMode === "none") {
    return {};
  }
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
