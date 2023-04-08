import express from "express";
import cors from "cors";
import pino from "pino";
import pinoHttp from "pino-http";

const PORT = process.env.PORT || 7860;

const app = express();
const logger = pino();

app.use(pinoHttp({ logger }));
app.use(cors());
app.use(
  express.json({ limit: "10mb" }),
  express.urlencoded({ extended: true, limit: "10mb" })
);

app.get("/", (req, res) => {
  logger.info("Hello world");
  res.send("hello :)");
});

app.use((err: any, _req: unknown, res: express.Response, _next: unknown) => {
  if (err.status) {
    res.status(err.status).json({ error: err.message });
  } else {
    logger.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
});

app.listen(PORT, () => {
  logger.info(`Server listening on port ${PORT}`);
});
