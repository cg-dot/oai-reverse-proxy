import dotenv from "dotenv";
dotenv.config();
import express from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import { logger } from "./logger";
import { keys } from "./keys";
import { proxyRouter } from "./proxy/routes";
import { handleInfoPage } from "./info-page";

const PORT = process.env.PORT || 7860;

const app = express();
// middleware
app.use(pinoHttp({ logger }));
app.use(cors());
app.use(
  express.json({ limit: "10mb" }),
  express.urlencoded({ extended: true, limit: "10mb" })
);
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
  keys.init();
});
