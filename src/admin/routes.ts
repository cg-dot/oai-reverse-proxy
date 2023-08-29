import express, { Router } from "express";
import cookieParser from "cookie-parser";
import { authorize } from "./auth";
import { HttpError, injectLocals } from "./common";
import { injectCsrfToken, checkCsrfToken } from "./csrf";
import { loginRouter } from "./login";
import { usersApiRouter as apiRouter } from "./api/users";
import { usersUiRouter as uiRouter } from "./ui/users";

const adminRouter = Router();

adminRouter.use(
  express.json({ limit: "20mb" }),
  express.urlencoded({ extended: true, limit: "20mb" })
);
adminRouter.use(cookieParser());
adminRouter.use(injectCsrfToken);

adminRouter.use("/users", authorize({ via: "header" }), apiRouter);

adminRouter.use(checkCsrfToken); // All UI routes require CSRF token
adminRouter.use(injectLocals);
adminRouter.use("/", loginRouter);
adminRouter.use("/manage", authorize({ via: "cookie" }), uiRouter);

adminRouter.use(
  (
    err: Error,
    _req: express.Request,
    res: express.Response,
    _next: express.NextFunction
  ) => {
    const data: any = { message: err.message, stack: err.stack };
    if (err instanceof HttpError) {
      data.status = err.status;
      return res.status(err.status).render("admin/error", data);
    } else if (err.name === "ForbiddenError") {
      data.status = 403;
      if (err.message === "invalid csrf token") {
        data.message = "Invalid CSRF token; try refreshing the previous page before submitting again.";
      }
      return res.status(403).render("admin/error", { ...data, flash: null });
    }
    res.status(500).json({ error: data });
  }
);

export { adminRouter };
