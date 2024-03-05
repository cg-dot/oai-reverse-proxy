import { Router } from "express";
import { UserPartialSchema } from "../../shared/users/schema";
import * as userStore from "../../shared/users/user-store";
import { ForbiddenError, BadRequestError } from "../../shared/errors";
import { sanitizeAndTrim } from "../../shared/utils";
import { config } from "../../config";

const router = Router();

router.use((req, res, next) => {
  if (req.session.userToken) {
    res.locals.currentSelfServiceUser =
      userStore.getUser(req.session.userToken) || null;
  }
  next();
});

router.get("/", (_req, res) => {
  res.redirect("/");
});

router.get("/lookup", (_req, res) => {
  const ipLimit =
    (res.locals.currentSelfServiceUser?.maxIps ?? config.maxIpsPerUser) || 0;
  res.render("user_lookup", {
    user: res.locals.currentSelfServiceUser,
    ipLimit,
  });
});

router.post("/lookup", (req, res) => {
  const token = req.body.token;
  const user = userStore.getUser(token);
  req.log.info(
    { token: truncateToken(token), success: !!user },
    "User self-service lookup"
  );
  if (!user) {
    req.session.flash = { type: "error", message: "Invalid user token." };
    return res.redirect("/user/lookup");
  }
  req.session.userToken = user.token;
  return res.redirect("/user/lookup");
});

router.post("/edit-nickname", (req, res) => {
  const existing = res.locals.currentSelfServiceUser;

  if (!existing) {
    throw new ForbiddenError("Not logged in.");
  } else if (!config.allowNicknameChanges || existing.disabledAt) {
    throw new ForbiddenError("Nickname changes are not allowed.");
  } else if (!config.maxIpsAutoBan && !existing.ip.includes(req.ip)) {
    throw new ForbiddenError(
      "Nickname changes are only allowed from registered IPs."
    );
  }

  const schema = UserPartialSchema.pick({ nickname: true })
    .strict()
    .transform((v) => ({ nickname: sanitizeAndTrim(v.nickname) }));

  const result = schema.safeParse(req.body);
  if (!result.success) {
    throw new BadRequestError(result.error.message);
  }

  const newNickname = result.data.nickname || null;
  userStore.upsertUser({ token: existing.token, nickname: newNickname });
  req.session.flash = { type: "success", message: "Nickname updated." };
  return res.redirect("/user/lookup");
});

function truncateToken(token: string) {
  const sliceLength = Math.max(Math.floor(token.length / 8), 1);
  return `${token.slice(0, sliceLength)}...${token.slice(-sliceLength)}`;
}

export { router as selfServiceRouter };
