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
    keyInfo = {
      ...keyInfo,
      trial: keys.filter((k) => k.isTrial).length,
      gpt4: keys.filter((k) => k.isGpt4).length,
      remainingQuota: `${Math.round(keyPool.calculateRemainingQuota() * 100)}%`,
    };
  }

  const info = {
    uptime: process.uptime(),
    timestamp: Date.now(),
    appUrls: {
      tavern: {
        kobold: host,
        openai: host + "/proxy/openai/v1",
      },
      agnaistic: {
        kobold: host,
        openai: host + "/proxy/openai",
      },
    },
    proompts: keys.reduce((acc, k) => acc + k.promptCount, 0),
    ...(config.modelRateLimit ? { proomptersNow: getUniqueIps() } : {}),
    keyInfo,
    config: listConfig(),
    sha: process.env.COMMIT_SHA?.slice(0, 7) || "dev",
  };

  const readme = require("fs").readFileSync("info-page.md", "utf8");
  const readmeBody = readme.split("---")[2] || readme;
  const converter = new showdown.Converter();
  const html = converter.makeHtml(readmeBody);

  const pageBody = `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>OpenAI Reverse Proxy</title>
  </head>
  <body style="font-family: sans-serif; background-color: #f0f0f0; padding: 1em;"
    ${html}
    <hr />
    <h2>Service Info</h2>
    <pre>${JSON.stringify(info, null, 2)}</pre>
  </body>
</html>`;

  return pageBody;
}
