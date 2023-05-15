import { assertConfigIsValid, config } from "./config";
import "source-map-support/register";
import express from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import childProcess from "child_process";
import { logger } from "./logger";
import { keyPool } from "./key-management";
import { adminRouter } from "./admin/routes";
import { proxyRouter, rewriteTavernRequests } from "./proxy/routes";
import { handleInfoPage } from "./info-page";
import { logQueue } from "./prompt-logging";
import { start as startRequestQueue } from "./proxy/queue";
import { init as initUserStore } from "./proxy/auth/user-store";

const PORT = config.port;

const app = express();
// middleware
app.use("/", rewriteTavernRequests);
app.use(
  pinoHttp({
    quietReqLogger: true,
    logger,
    autoLogging: {
      ignore: (req) => {
        const ignored = ["/proxy/kobold/api/v1/model", "/health"];
        return ignored.includes(req.url as string);
      },
    },
    redact: {
      paths: [
        "req.headers.cookie",
        'res.headers["set-cookie"]',
        "req.headers.authorization",
        'req.headers["x-forwarded-for"]',
        'req.headers["x-real-ip"]',
      ],
      censor: "********",
    },
  })
);

app.get("/health", (_req, res) => res.sendStatus(200));
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

// TODO: Detect (or support manual configuration of) whether the app is behind
// a load balancer/reverse proxy, which is necessary to determine request IP
// addresses correctly.
app.set("trust proxy", true);

// routes
app.get("/", handleInfoPage);
app.use("/admin", adminRouter);
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

async function start() {
  logger.info("Server starting up...");
  setGitSha();

  logger.info("Checking configs and external dependencies...");
  await assertConfigIsValid();

  keyPool.init();

  if (config.gatekeeper === "user_token") {
    await initUserStore();
  }

  if (config.promptLogging) {
    logger.info("Starting prompt logging...");
    logQueue.start();
  }

  if (config.queueMode !== "none") {
    logger.info("Starting request queue...");
    startRequestQueue();
  }

  app.listen(PORT, async () => {
    logger.info({ port: PORT }, "Now listening for connections.");
    registerUncaughtExceptionHandler();
  });

  logger.info(
    { sha: process.env.COMMIT_SHA, nodeEnv: process.env.NODE_ENV },
    "Startup complete."
  );
}

function registerUncaughtExceptionHandler() {
  process.on("uncaughtException", (err: any) => {
    logger.error(
      { err, stack: err?.stack },
      "UNCAUGHT EXCEPTION. Please report this error trace."
    );
  });
  process.on("unhandledRejection", (err: any) => {
    logger.error(
      { err, stack: err?.stack },
      "UNCAUGHT PROMISE REJECTION. Please report this error trace."
    );
  });
}

function setGitSha() {
  // On Render, the .git directory isn't available in the docker build context
  // so we can't get the SHA directly, but they expose it as an env variable.
  if (process.env.RENDER) {
    const shaString = `${process.env.RENDER_GIT_COMMIT?.slice(0, 7)} (${
      process.env.RENDER_GIT_REPO_SLUG
    })`;
    process.env.COMMIT_SHA = shaString;
    logger.info({ sha: shaString }, "Got commit SHA via Render config.");
    return;
  }

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
}

start();
