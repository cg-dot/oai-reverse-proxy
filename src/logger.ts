import pino from "pino";
import { config } from "./config";

const transport =
  process.env.NODE_ENV === "production"
    ? undefined
    : {
        target: "pino-pretty",
        options: {
          singleLine: true,
          messageFormat: "{if module}\x1b[90m[{module}] \x1b[39m{end}{msg}",
          ignore: "module",
        },
      };

export const logger = pino({
  level: config.logLevel,
  base: { pid: process.pid, module: "server" },
  transport,
});
