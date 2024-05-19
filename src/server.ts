import { assertConfigIsValid, config, USER_ASSETS_DIR } from "./config";
import "source-map-support/register";
import checkDiskSpace from "check-disk-space";
import express from "express";
import cors from "cors";
import path from "path";
import pinoHttp from "pino-http";
import os from "os";
import childProcess from "child_process";
import { logger } from "./logger";
import { createBlacklistMiddleware } from "./shared/cidr";
import { setupAssetsDir } from "./shared/file-storage/setup-assets-dir";
import { keyPool } from "./shared/key-management";
import { adminRouter } from "./admin/routes";
import { proxyRouter } from "./proxy/routes";
import { infoPageRouter } from "./info-page";
import { IMAGE_GEN_MODELS } from "./shared/models";
import { userRouter } from "./user/routes";
import { logQueue } from "./shared/prompt-logging";
import { start as startRequestQueue } from "./proxy/queue";
import { init as initUserStore } from "./shared/users/user-store";
import { init as initTokenizers } from "./shared/tokenization";
import { checkOrigin } from "./proxy/check-origin";
import { sendErrorToClient } from "./proxy/middleware/response/error-generator";

const PORT = config.port;
const BIND_ADDRESS = config.bindAddress;

const app = express();
// middleware
app.use(
  pinoHttp({
    quietReqLogger: true,
    logger,
    autoLogging: { ignore: ({ url }) => ["/health"].includes(url as string) },
    redact: {
      paths: [
        "req.headers.cookie",
        'res.headers["set-cookie"]',
        "req.headers.authorization",
        'req.headers["x-api-key"]',
        // Don't log the prompt text on transform errors
        "body.messages",
        "body.prompt",
      ],
      censor: "********",
    },
    customProps: (req) => {
      const user = (req as express.Request).user;
      if (user) return { userToken: `...${user.token.slice(-5)}` };
      return {};
    },
  })
);

app.set("trust proxy", Number(config.trustedProxies));

app.set("view engine", "ejs");
app.set("views", [
  path.join(__dirname, "admin/web/views"),
  path.join(__dirname, "user/web/views"),
  path.join(__dirname, "shared/views"),
]);

app.use("/user_content", express.static(USER_ASSETS_DIR, { maxAge: "2h" }));
app.use(
  "/res",
  express.static(path.join(__dirname, "..", "public"), { etag: true })
);

app.get("/health", (_req, res) => res.sendStatus(200));
app.use(cors());

const blacklist = createBlacklistMiddleware("IP_BLACKLIST", config.ipBlacklist);
app.use(blacklist);

app.use(checkOrigin);

app.use("/admin", adminRouter);
app.use(config.proxyEndpointRoute, proxyRouter);
app.use("/user", userRouter);
if (config.staticServiceInfo) {
  app.get("/", (_req, res) => res.sendStatus(200));
} else {
  app.use("/", infoPageRouter);
}

app.use(
  (err: any, req: express.Request, res: express.Response, _next: unknown) => {
    if (!err.status) {
      logger.error(err, "Unhandled error in request");
    }

    sendErrorToClient({
      req,
      res,
      options: {
        title: `Proxy error (HTTP ${err.status})`,
        message:
          "Reverse proxy encountered an unexpected error while processing your request.",
        reqId: req.id,
        statusCode: err.status,
        obj: { error: err.message, stack: err.stack },
        format: "unknown",
      },
    });
  }
);
app.use((_req: unknown, res: express.Response) => {
  res.status(404).json({ error: "Not found" });
});

async function start() {
  logger.info("Server starting up...");
  await setBuildInfo();

  logger.info("Checking configs and external dependencies...");
  await assertConfigIsValid();

  keyPool.init();

  await initTokenizers();

  if (config.allowedModelFamilies.some((f) => IMAGE_GEN_MODELS.includes(f))) {
    await setupAssetsDir();
  }

  if (config.gatekeeper === "user_token") {
    await initUserStore();
  }

  if (config.promptLogging) {
    logger.info("Starting prompt logging...");
    await logQueue.start();
  }

  logger.info("Starting request queue...");
  startRequestQueue();

  const diskSpace = await checkDiskSpace(
    __dirname.startsWith("/app") ? "/app" : os.homedir()
  );

  app.listen(PORT, BIND_ADDRESS, () => {
    logger.info(
      { port: PORT, interface: BIND_ADDRESS },
      "Now listening for connections."
    );
    registerUncaughtExceptionHandler();
  });

  logger.info(
    { build: process.env.BUILD_INFO, nodeEnv: process.env.NODE_ENV, diskSpace },
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

/**
 * Attepts to collect information about the current build from either the
 * environment or the git repo used to build the image (only works if not
 * .dockerignore'd). If you're running a sekrit club fork, you can no-op this
 * function and set the BUILD_INFO env var manually, though I would prefer you
 * didn't set it to something misleading.
 */
async function setBuildInfo() {
  // For CI builds, use the env vars set during the build process
  if (process.env.GITGUD_BRANCH) {
    const sha = process.env.GITGUD_COMMIT?.slice(0, 7) || "unknown SHA";
    const branch = process.env.GITGUD_BRANCH;
    const repo = process.env.GITGUD_PROJECT;
    const buildInfo = `[ci] ${sha} (${branch}@${repo})`;
    process.env.BUILD_INFO = buildInfo;
    logger.info({ build: buildInfo }, "Using build info from CI image.");
    return;
  }

  // For render, the git directory is dockerignore'd so we use env vars
  if (process.env.RENDER) {
    const sha = process.env.RENDER_GIT_COMMIT?.slice(0, 7) || "unknown SHA";
    const branch = process.env.RENDER_GIT_BRANCH || "unknown branch";
    const repo = process.env.RENDER_GIT_REPO_SLUG || "unknown repo";
    const buildInfo = `${sha} (${branch}@${repo})`;
    process.env.BUILD_INFO = buildInfo;
    logger.info({ build: buildInfo }, "Got build info from Render config.");
    return;
  }

  // For huggingface and bare metal deployments, we can get the info from git
  try {
    if (process.env.SPACE_ID) {
      // TODO: may not be necessary anymore with adjusted Huggingface dockerfile
      childProcess.execSync("git config --global --add safe.directory /app");
    }

    const promisifyExec = (cmd: string) =>
      new Promise((resolve, reject) => {
        childProcess.exec(cmd, (err, stdout) =>
          err ? reject(err) : resolve(stdout)
        );
      });

    const promises = [
      promisifyExec("git rev-parse --short HEAD"),
      promisifyExec("git rev-parse --abbrev-ref HEAD"),
      promisifyExec("git config --get remote.origin.url"),
      promisifyExec("git status --porcelain"),
    ].map((p) => p.then((result: any) => result.toString().trim()));

    let [sha, branch, remote, status] = await Promise.all(promises);

    remote = remote.match(/.*[\/:]([\w-]+)\/([\w\-.]+?)(?:\.git)?$/) || [];
    const repo = remote.slice(-2).join("/");
    status = status
      // ignore Dockerfile changes since that's how the user deploys the app
      .split("\n")
      .filter((line: string) => !line.endsWith("Dockerfile") && line);

    const changes = status.length > 0;

    const build = `${sha}${changes ? " (modified)" : ""} (${branch}@${repo})`;
    process.env.BUILD_INFO = build;
    logger.info({ build, status, changes }, "Got build info from Git.");
  } catch (error: any) {
    logger.error(
      {
        error,
        stdout: error.stdout?.toString(),
        stderr: error.stderr?.toString(),
      },
      "Failed to get commit SHA.",
      error
    );
    process.env.BUILD_INFO = "unknown";
  }
}

start();
