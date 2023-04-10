import { config } from "./config";
import express from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import { logger } from "./logger";
import { keyPool } from "./key-management";
import { proxyRouter, rewriteTavernRequests } from "./proxy/routes";
import { handleInfoPage } from "./info-page";

const PORT = config.port;

const app = express();
// middleware
app.use("/", rewriteTavernRequests);
app.use(
  pinoHttp({
    logger,
    // SillyTavern spams the hell out of this endpoint so don't log it
    autoLogging: { ignore: (req) => req.url === "/proxy/kobold/api/v1/model" },
  })
);
app.use(cors());
app.use(
  express.json({ limit: "10mb" }),
  express.urlencoded({ extended: true, limit: "10mb" })
);
// trust proxy to set x-forwarded-for ips correctly
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
    res.status(500).json({ error: "Internal server error" });
  }
});
app.use((_req: unknown, res: express.Response) => {
  res.status(404).json({ error: "Not found" });
});
// start server and load keys
app.listen(PORT, () => {
  logger.info(`Server listening on port ${PORT}`);
  keyPool.init();
});
