import express, { Router } from "express";
import cookieParser from "cookie-parser";
import { authorize } from "./auth";
import { injectCsrfToken, checkCsrfToken } from "./csrf";
import { usersApiRouter as apiRouter } from "./api/users";
import { usersUiRouter as uiRouter } from "./ui/users";
import { loginRouter } from "./login";

const adminRouter = Router();

adminRouter.use(
  express.json({ limit: "20mb" }),
  express.urlencoded({ extended: true, limit: "20mb" })
);
adminRouter.use(cookieParser());
adminRouter.use(injectCsrfToken);

adminRouter.use("/users", authorize({ via: "header" }), apiRouter);

adminRouter.use(checkCsrfToken); // All UI routes require CSRF token
adminRouter.use("/", loginRouter);
adminRouter.use("/manage", authorize({ via: "cookie" }), uiRouter);

export { adminRouter };
