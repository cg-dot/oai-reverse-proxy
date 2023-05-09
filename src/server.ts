import { config } from "./config";
import "source-map-support/register";
import express from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import childProcess from "child_process";
import { logger } from "./logger";
import { keyPool } from "./key-management";
import { proxyRouter, rewriteTavernRequests } from "./proxy/routes";
import { handleInfoPage } from "./info-page";
import { logQueue } from "./prompt-logging";
import { start as startRequestQueue } from "./proxy/queue";

const PORT = config.port;

const app = express();
// middleware
app.use("/", rewriteTavernRequests);
app.use(
  pinoHttp({
    quietReqLogger: true,
    logger,
    // SillyTavern spams the hell out of this endpoint so don't log it
    autoLogging: { ignore: (req) => req.url === "/proxy/kobold/api/v1/model" },
    redact: {
      paths: [
        "req.headers.cookie",
        'res.headers["set-cookie"]',
        "req.headers.authorization",
        'req.headers["x-forwarded-for"]',
      ],
      censor: "********",
    },
  })
);
app.use((req, _res, next) => {
  req.startTime = Date.now();
  req.retryCount = 0;
  next();
});
app.use(cors());
app.use(
  express.json({ limit: "10mb" }),
  express.urlencoded({ extended: true, limit: "10mb" })
);
// TODO: this works if we're always being deployed to Huggingface but if users
// deploy this somewhere without a load balancer then incoming requests can
// spoof the X-Forwarded-For header and bypass the rate limiting.
app.set("trust proxy", true);

// routes
app.get("/", handleInfoPage);
app.use("/proxy", proxyRouter);

// 500 and 404
app.use((err: any, _req: unknown, res: express.Response, _next: unknown) => {
  if (err.status) {
    res.status(err.status).json({ error: err.message });
  } else {
    logger.error(err);
    res.status(500).json({
      error: {
        type: "proxy_error",
        message: err.message,
        stack: err.stack,
        proxy_note: `Reverse proxy encountered an internal server error.`,
      },
    });
  }
});
app.use((_req: unknown, res: express.Response) => {
  res.status(404).json({ error: "Not found" });
});

// start server and load keys
app.listen(PORT, async () => {
  try {
    // Huggingface seems to have changed something about how they deploy Spaces
    // and git commands fail because of some ownership issue with the .git
    // directory. This is a hacky workaround, but we only want to run it on
    // deployed instances.

    if (process.env.NODE_ENV === "production") {
      childProcess.execSync("git config --global --add safe.directory /app");
    }

    const sha = childProcess
      .execSync("git rev-parse --short HEAD")
      .toString()
      .trim();

    const status = childProcess
      .execSync("git status --porcelain")
      .toString()
      .trim()
      // ignore Dockerfile changes since that's how the user deploys the app
      .split("\n")
      .filter((line: string) => !line.endsWith("Dockerfile"));

    const changes = status.length > 0;

    logger.info({ sha, status, changes }, "Got commit SHA and status.");

    process.env.COMMIT_SHA = `${sha}${changes ? " (modified)" : ""}`;
  } catch (error: any) {
    logger.error(
      {
        error,
        stdout: error.stdout.toString(),
        stderr: error.stderr.toString(),
      },
      "Failed to get commit SHA.",
      error
    );
    process.env.COMMIT_SHA = "unknown";
  }

  logger.info(
    { sha: process.env.COMMIT_SHA },
    `Server listening on port ${PORT}`
  );
  keyPool.init();

  if (config.promptLogging) {
    logger.info("Starting prompt logging...");
    logQueue.start();
  }
  if (config.queueMode !== "none") {
    logger.info("Starting request queue...");
    startRequestQueue();
  }
});
