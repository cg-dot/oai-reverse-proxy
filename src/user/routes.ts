import express, { Router } from "express";
import { injectCsrfToken, checkCsrfToken } from "../shared/inject-csrf";
import { browseImagesRouter } from "./web/browse-images";
import { selfServiceRouter } from "./web/self-service";
import { powRouter } from "./web/pow-captcha";
import { injectLocals } from "../shared/inject-locals";
import { withSession } from "../shared/with-session";
import { config } from "../config";

const userRouter = Router();

userRouter.use(
  express.json({ limit: "1mb" }),
  express.urlencoded({ extended: true, limit: "1mb" })
);
userRouter.use(withSession);
userRouter.use(injectCsrfToken, checkCsrfToken);
userRouter.use(injectLocals);
if (config.showRecentImages) {
  userRouter.use(browseImagesRouter);
}
if (config.captchaMode !== "none") {
  userRouter.use("/captcha", powRouter);
}
userRouter.use(selfServiceRouter);

userRouter.use(
  (
    err: Error,
    req: express.Request,
    res: express.Response,
    _next: express.NextFunction
  ) => {
    const data: any = { message: err.message, stack: err.stack, status: 500 };

    if (req.accepts("json", "html") === "json") {
      const isCsrfError = err.message === "invalid csrf token";
      const message = isCsrfError
        ? "CSRF token mismatch; try refreshing the page"
        : err.message;

      return res.status(500).json({ error: message });
    } else {
      return res.status(500).render("user_error", { ...data, flash: null });
    }
  }
);

export { userRouter };
