import express, { Router } from "express";
import { injectCsrfToken, checkCsrfToken } from "../shared/inject-csrf";
import { selfServiceRouter } from "./web/self-service";
import { injectLocals } from "../shared/inject-locals";
import { withSession } from "../shared/with-session";

const userRouter = Router();

userRouter.use(
  express.json({ limit: "1mb" }),
  express.urlencoded({ extended: true, limit: "1mb" })
);
userRouter.use(withSession);
userRouter.use(injectCsrfToken, checkCsrfToken);
userRouter.use(injectLocals);

userRouter.use(selfServiceRouter);

userRouter.use(
  (
    err: Error,
    _req: express.Request,
    res: express.Response,
    _next: express.NextFunction
  ) => {
    const data: any = { message: err.message, stack: err.stack, status: 500 };
    res.status(500).render("user_error", { ...data, flash: null });
  }
);

export { userRouter };
