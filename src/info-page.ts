import { Request, Response } from "express";
import { keys } from "./keys";

export const handleInfoPage = (req: Request, res: Response) => {
  res.send(getInfoPageHtml(req.protocol + "://" + req.get("host")));
};

function getInfoPageHtml(host: string) {
  const keylist = keys.list();
  const info = {
    message: "OpenAI Reverse Proxy",
    uptime: process.uptime(),
    timestamp: Date.now(),
    kobold: host + "/kobold",
    openai: host + "/openai",
    keys: {
      all: keylist.length,
      active: keylist.filter((k) => !k.isDisabled).length,
      trial: keylist.filter((k) => k.isTrial).length,
      gpt4: keylist.filter((k) => k.isGpt4).length,
    },
  };

  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>OpenAI Reverse Proxy</title>
  </head>
  <body>
    <h1>OpenAI Reverse Proxy</h1>
    <pre>${JSON.stringify(info, null, 2)}</pre>
  </body>
</html>`;
}
