import express, { Router } from "express";
import cookieParser from "cookie-parser";
import { config } from "../config";
import { auth } from "./auth";
import { loginRouter } from "./controllers/login";
import { usersRouter } from "./controllers/users";

const adminRouter = Router();

adminRouter.use(
  express.json({ limit: "20mb" }),
  express.urlencoded({ extended: true, limit: "20mb" })
);
adminRouter.use(cookieParser());

adminRouter.use("/", loginRouter);
adminRouter.use(auth);
adminRouter.use("/users", usersRouter);
adminRouter.get("/", (_req, res) => {
  res.render("admin/index", {
    isPersistenceEnabled: config.gatekeeperStore !== "memory",
  });
});

export { adminRouter };
