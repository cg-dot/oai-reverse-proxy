import fs from "fs";
import { Request, Response } from "express";
import showdown from "showdown";
import { config, listConfig } from "./config";
import { keyPool } from "./key-management";
import { getUniqueIps } from "./proxy/rate-limit";
import { getEstimatedWaitTime, getQueueLength } from "./proxy/queue";

const INFO_PAGE_TTL = 5000;
let infoPageHtml: string | undefined;
let infoPageLastUpdated = 0;

export const handleInfoPage = (req: Request, res: Response) => {
  if (infoPageLastUpdated + INFO_PAGE_TTL > Date.now()) {
    res.send(infoPageHtml);
    return;
  }

  // Some load balancers/reverse proxies don't give us the right protocol in
  // the host header. Huggingface works this way, Cloudflare does not.
  const host = req.get("host");
  const isHuggingface = host?.includes("hf.space");
  const protocol = isHuggingface ? "https" : req.protocol;
  res.send(cacheInfoPageHtml(protocol + "://" + host));
};

function cacheInfoPageHtml(host: string) {
  const keys = keyPool.list();
  let keyInfo: Record<string, any> = { all: keys.length };
  
  const openAIKeys = keys.filter((k) => k.service === "openai");
  const anthropicKeys = keys.filter((k) => k.service === "anthropic");

  let anthropicInfo: Record<string, any> = {
    all: anthropicKeys.length,
    active: anthropicKeys.filter((k) => !k.isDisabled).length,
  };
  let openAIInfo: Record<string, any> = {
    all: openAIKeys.length,
    active: openAIKeys.filter((k) => !k.isDisabled).length,
  };

  if (keyPool.anyUnchecked()) {
    const uncheckedKeys = keys.filter((k) => !k.lastChecked);
    openAIInfo = {
      ...openAIInfo,
      active: keys.filter((k) => !k.isDisabled).length,
      status: `Still checking ${uncheckedKeys.length} keys...`,
    };
  } else if (config.checkKeys) {
    const trialKeys = openAIKeys.filter((k) => k.isTrial);
    const turboKeys = openAIKeys.filter((k) => !k.isGpt4 && !k.isDisabled);
    const gpt4Keys = openAIKeys.filter((k) => k.isGpt4 && !k.isDisabled);

    const quota: Record<string, string> = { turbo: "", gpt4: "" };
    const hasGpt4 = openAIKeys.some((k) => k.isGpt4);
    const turboQuota = keyPool.remainingQuota("openai") * 100;
    const gpt4Quota = keyPool.remainingQuota("openai", { gpt4: true }) * 100;

    if (config.quotaDisplayMode === "full") {
      const turboUsage = keyPool.usageInUsd("openai");
      const gpt4Usage = keyPool.usageInUsd("openai", { gpt4: true });
      quota.turbo = `${turboUsage} (${Math.round(turboQuota)}% remaining)`;
      quota.gpt4 = `${gpt4Usage} (${Math.round(gpt4Quota)}% remaining)`;
    } else {
      quota.turbo = `${Math.round(turboQuota)}%`;
      quota.gpt4 = `${Math.round(gpt4Quota * 100)}%`;
    }

    if (!hasGpt4) {
      delete quota.gpt4;
    }

    openAIInfo = {
      ...openAIInfo,
      trial: trialKeys.length,
      active: {
        turbo: turboKeys.length,
        ...(hasGpt4 ? { gpt4: gpt4Keys.length } : {}),
      },
      ...(config.quotaDisplayMode !== "none" ? { quota: quota } : {}),
    };
  }

  keyInfo = {
    ...(openAIKeys.length ? { openai: openAIInfo } : {}),
    ...(anthropicKeys.length ? { anthropic: anthropicInfo } : {}),
  };

  const info = {
    uptime: process.uptime(),
    endpoints: {
      kobold: host,
      openai: host + "/proxy/openai",
      anthropic: host + "/proxy/anthropic",
    },
    proompts: keys.reduce((acc, k) => acc + k.promptCount, 0),
    ...(config.modelRateLimit ? { proomptersNow: getUniqueIps() } : {}),
    ...getQueueInformation(),
    keys: keyInfo,
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
    const friendlyWaitTime = getQueueInformation().estimatedQueueTime;
    infoBody += `\n### Estimated Wait Time: ${friendlyWaitTime}
Queueing is enabled. If the AI is busy, your prompt will processed when a slot frees up.

**Enable Streaming in your preferred front-end to prevent timeouts while waiting in the queue.**`;
  }

  if (customGreeting) {
    infoBody += `\n## Server Greeting\n
${customGreeting}`;
  }
  return converter.makeHtml(infoBody);
}

/** Returns queue time in seconds, or minutes + seconds if over 60 seconds. */
function getQueueInformation() {
  if (config.queueMode === "none") {
    return {};
  }
  const waitMs = getEstimatedWaitTime();
  const waitTime =
    waitMs < 60000
      ? `${Math.round(waitMs / 1000)}sec`
      : `${Math.round(waitMs / 60000)}min, ${Math.round(
          (waitMs % 60000) / 1000
        )}sec`;
  return {
    proomptersInQueue: getQueueLength(),
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
