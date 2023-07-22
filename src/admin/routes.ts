import express, { RequestHandler, Router } from "express";
import { config } from "../config";
import { usersRouter } from "./users";

const ADMIN_KEY = config.adminKey;
const failedAttempts = new Map<string, number>();

const adminRouter = Router();

const auth: RequestHandler = (req, res, next) => {
  const token = req.headers.authorization?.slice("Bearer ".length);
  const attempts = failedAttempts.get(req.ip) ?? 0;
  if (attempts > 5) {
    req.log.warn(
      { ip: req.ip, token },
      `Blocked request to admin API due to too many failed attempts`
    );
    return res.status(401).json({ error: "Too many attempts" });
  }

  if (token !== ADMIN_KEY) {
    const newAttempts = attempts + 1;
    failedAttempts.set(req.ip, newAttempts);
    req.log.warn(
      { ip: req.ip, attempts: newAttempts, token },
      `Attempted admin API request with invalid token`
    );
    return res.status(401).json({ error: "Unauthorized" });
  }

  next();
};

adminRouter.use(auth);
adminRouter.use(
  express.json({ limit: "20mb" }),
  express.urlencoded({ extended: true, limit: "20mb" })
);
adminRouter.use("/users", usersRouter);
export { adminRouter };
