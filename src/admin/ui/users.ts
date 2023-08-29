import { Router } from "express";
import multer from "multer";
import { z } from "zod";
import { config } from "../../config";
import * as userStore from "../../proxy/auth/user-store";
import {
  UserSchemaWithToken,
  parseSort,
  sortBy,
  paginate,
  UserSchema,
  HttpError,
} from "../common";
import { keyPool } from "../../key-management";

const router = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  fileFilter: (_req, file, cb) => {
    if (file.mimetype !== "application/json") {
      cb(new Error("Invalid file type"));
    } else {
      cb(null, true);
    }
  },
});

router.get("/create-user", (req, res) => {
  const recentUsers = userStore
    .getUsers()
    .sort(sortBy(["createdAt"], false))
    .slice(0, 5);
  res.render("admin/create-user", {
    recentUsers,
    newToken: !!req.query.created,
  });
});

router.post("/create-user", (_req, res) => {
  userStore.createUser();
  return res.redirect(`/admin/manage/create-user?created=true`);
});

router.get("/view-user/:token", (req, res) => {
  const user = userStore.getUser(req.params.token);
  if (!user) throw new HttpError(404, "User not found");

  if (req.query.refreshed) {
    res.locals.flash = {
      type: "success",
      message: "User's quota was refreshed",
    };
  }
  res.render("admin/view-user", { user });
});

router.get("/list-users", (req, res) => {
  const sort = parseSort(req.query.sort) || ["promptCount", "lastUsedAt"];
  const requestedPageSize =
    Number(req.query.perPage) || Number(req.cookies.perPage) || 20;
  const perPage = Math.max(1, Math.min(1000, requestedPageSize));
  const users = userStore
    .getUsers()
    .map((user) => {
      const sum = Object.values(user.tokenCounts).reduce((a, b) => a + b, 0); // TODO: cache
      return { ...user, sumTokenCounts: sum };
    })
    .sort(sortBy(sort, false));

  const page = Number(req.query.page) || 1;
  const { items, ...pagination } = paginate(users, page, perPage);

  return res.render("admin/list-users", {
    sort: sort.join(","),
    users: items,
    ...pagination,
  });
});

router.get("/import-users", (_req, res) => {
  res.render("admin/import-users");
});

router.post("/import-users", upload.single("users"), (req, res) => {
  if (!req.file) throw new HttpError(400, "No file uploaded");

  const data = JSON.parse(req.file.buffer.toString());
  const result = z.array(UserSchemaWithToken).safeParse(data.users);
  if (!result.success) throw new HttpError(400, result.error.toString());

  const upserts = result.data.map((user) => userStore.upsertUser(user));
  res.render("admin/import-users", {
    flash: { type: "success", message: `${upserts.length} users imported` },
  });
});

router.get("/export-users", (_req, res) => {
  res.render("admin/export-users");
});

router.get("/export-users.json", (_req, res) => {
  const users = userStore.getUsers();
  res.setHeader("Content-Disposition", "attachment; filename=users.json");
  res.setHeader("Content-Type", "application/json");
  res.send(JSON.stringify({ users }, null, 2));
});

router.get("/", (_req, res) => {
  res.render("admin/index");
});

router.post("/edit-user/:token", (req, res) => {
  const result = UserSchema.safeParse(req.body);
  if (!result.success) throw new HttpError(400, result.error.toString());

  userStore.upsertUser({ ...result.data, token: req.params.token });
  return res.sendStatus(204);
});

router.post("/reactivate-user/:token", (req, res) => {
  const user = userStore.getUser(req.params.token);
  if (!user) throw new HttpError(404, "User not found");

  userStore.upsertUser({
    token: user.token,
    disabledAt: 0,
    disabledReason: "",
  });
  return res.sendStatus(204);
});

router.post("/disable-user/:token", (req, res) => {
  const user = userStore.getUser(req.params.token);
  if (!user) throw new HttpError(404, "User not found");

  userStore.disableUser(req.params.token, req.body.reason);
  return res.sendStatus(204);
});

router.post("/refresh-user-quota", (req, res) => {
  const user = userStore.getUser(req.body.token);
  if (!user) throw new HttpError(404, "User not found");

  userStore.refreshQuota(req.body.token);
  return res.redirect(`/admin/manage/view-user/${req.body.token}?refreshed=1`);
});

router.post("/maintenance", (req, res) => {
  const action = req.body.action;
  let message = "";
  switch (action) {
    case "recheck": {
      keyPool.recheck("openai");
      const size = keyPool
        .list()
        .filter((key) => key.service === "openai").length;
      message = `success: Scheduled recheck of ${size} OpenAI keys.`;
      break;
    }
    case "resetQuotas": {
      const users = userStore.getUsers();
      users.forEach((user) => userStore.refreshQuota(user.token));
      const { claude, gpt4, turbo } = config.tokenQuota;
      message = `success: All users' token quotas reset to ${turbo} (Turbo), ${gpt4} (GPT-4), ${claude} (Claude).`;
      break;
    }
    default: {
      throw new HttpError(400, "Invalid action");
    }
  }
  return res.redirect(`/admin/manage?flash=${message}`);
});

export { router as usersUiRouter };
