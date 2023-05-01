import fs from "fs";
import { Request, Response } from "express";
import showdown from "showdown";
import { config, listConfig } from "./config";
import { keyPool } from "./key-management";
import { getUniqueIps } from "./proxy/rate-limit";

export const handleInfoPage = (req: Request, res: Response) => {
  // Huggingface puts spaces behind some cloudflare ssl proxy, so `req.protocol` is `http` but the correct URL is actually `https`
  const host = req.get("host");
  const isHuggingface = host?.includes("hf.space");
  const protocol = isHuggingface ? "https" : req.protocol;
  res.send(getInfoPageHtml(protocol + "://" + host));
};

function getInfoPageHtml(host: string) {
  const keys = keyPool.list();
  let keyInfo: Record<string, any> = {
    all: keys.length,
    active: keys.filter((k) => !k.isDisabled).length,
  };

  if (keyPool.anyUnchecked()) {
    const uncheckedKeys = keys.filter((k) => !k.lastChecked);
    keyInfo = {
      ...keyInfo,
      status: `Still checking ${uncheckedKeys.length} keys...`,
    };
  } else if (config.checkKeys) {
    const hasGpt4 = keys.some((k) => k.isGpt4);
    keyInfo = {
      ...keyInfo,
      trial: keys.filter((k) => k.isTrial).length,
      gpt4: keys.filter((k) => k.isGpt4).length,
      quotaLeft: {
        all: `${Math.round(keyPool.remainingQuota() * 100)}%`,
        ...(hasGpt4
          ? { gpt4: `${Math.round(keyPool.remainingQuota(true) * 100)}%` }
          : {}),
      },
    };
  }

  const info = {
    uptime: process.uptime(),
    timestamp: Date.now(),
    endpoints: {
      kobold: host,
      openai: host + "/proxy/openai",
    },
    proompts: keys.reduce((acc, k) => acc + k.promptCount, 0),
    ...(config.modelRateLimit ? { proomptersNow: getUniqueIps() } : {}),
    keyInfo,
    config: listConfig(),
    commitSha: process.env.COMMIT_SHA || "dev",
  };
  
  const title = process.env.SPACE_ID
    ? `${process.env.SPACE_AUTHOR_NAME} / ${process.env.SPACE_TITLE}`
    : "OAI Reverse Proxy";

  const pageBody = `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>${title}</title>
  </head>
  <body style="font-family: sans-serif; background-color: #f0f0f0; padding: 1em;"
    ${infoPageHeaderHtml}
    <hr />
    <h2>Service Info</h2>
    <pre>${JSON.stringify(info, null, 2)}</pre>
  </body>
</html>`;

  return pageBody;
}

const infoPageHeaderHtml = buildInfoPageHeader(new showdown.Converter());

/**
 * If the server operator provides a `greeting.md` file, it will be included in
 * the rendered info page.
 **/
function buildInfoPageHeader(converter: showdown.Converter) {
  const genericInfoPage = fs.readFileSync("info-page.md", "utf8");
  const customGreeting = fs.existsSync("greeting.md")
    ? fs.readFileSync("greeting.md", "utf8")
    : null;

  let infoBody = genericInfoPage;
  if (config.promptLogging) {
    infoBody += `\n## Prompt logging is enabled!
The server operator has enabled prompt logging. The prompts you send to this proxy and the AI responses you receive may be saved.

Logs are anonymous and do not contain IP addresses or timestamps. [You can see the type of data logged here, along with the rest of the code.](https://gitgud.io/khanon/oai-reverse-proxy/-/blob/main/src/prompt-logging/index.ts).

**If you are uncomfortable with this, don't send prompts to this proxy!**`;
  }
  if (customGreeting) {
    infoBody += `\n## Server Greeting\n
${customGreeting}`;
  }
  return converter.makeHtml(infoBody);
}
