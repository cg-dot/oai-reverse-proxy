import { Request, Response } from "express";
import showdown from "showdown";
import { config, listConfig } from "./config";
import { keys } from "./keys";
import { getUniqueIps } from "./proxy/rate-limit";

export const handleInfoPage = (req: Request, res: Response) => {
  // Huggingface puts spaces behind some cloudflare ssl proxy, so `req.protocol` is `http` but the correct URL is actually `https`
  const host = req.get("host");
  const isHuggingface = host?.includes("hf.space");
  const protocol = isHuggingface ? "https" : req.protocol;
  res.send(getInfoPageHtml(protocol + "://" + host));
};

function getInfoPageHtml(host: string) {
  const keylist = keys.list();
  const rateLimitInfo = { proomptersLastFiveMinutes: getUniqueIps() };
  const info = {
    uptime: process.uptime(),
    timestamp: Date.now(),
    baseUrl: host,
    kobold: host + "/proxy/kobold",
    openai: host + "/proxy/openai",
    proompts: keylist.reduce((acc, k) => acc + k.promptCount, 0),
    ...(config.modelRateLimit ? rateLimitInfo : {}),
    keys: {
      all: keylist.length,
      active: keylist.filter((k) => !k.isDisabled).length,
      trial: keylist.filter((k) => k.isTrial).length,
      gpt4: keylist.filter((k) => k.isGpt4).length,
    },
    config: listConfig(),
  };

  const readme = require("fs").readFileSync("README.md", "utf8");
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
