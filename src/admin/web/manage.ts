import { Router } from "express";
import multer from "multer";
import { z } from "zod";
import { config } from "../../config";
import { HttpError } from "../../shared/errors";
import * as userStore from "../../shared/users/user-store";
import { parseSort, sortBy, paginate } from "../../shared/utils";
import { keyPool } from "../../shared/key-management";
import { MODEL_FAMILIES } from "../../shared/models";
import { getTokenCostUsd, prettyTokens } from "../../shared/stats";
import {
  User,
  UserPartialSchema,
  UserSchema,
  UserTokenCounts,
} from "../../shared/users/schema";

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
  res.render("admin_create-user", {
    recentUsers,
    newToken: !!req.query.created,
  });
});

router.post("/create-user", (req, res) => {
  const body = req.body;

  const base = z.object({ type: UserSchema.shape.type.default("normal") });
  const tempUser = base
    .extend({
      temporaryUserDuration: z.coerce
        .number()
        .int()
        .min(1)
        .max(10080 * 4),
    })
    .merge(
      MODEL_FAMILIES.reduce((schema, model) => {
        return schema.extend({
          [`temporaryUserQuota_${model}`]: z.coerce.number().int().min(0),
        });
      }, z.object({}))
    )
    .transform((data: any) => {
      const expiresAt = Date.now() + data.temporaryUserDuration * 60 * 1000;
      const tokenLimits = MODEL_FAMILIES.reduce((limits, model) => {
        limits[model] = data[`temporaryUserQuota_${model}`];
        return limits;
      }, {} as UserTokenCounts);
      return { ...data, expiresAt, tokenLimits };
    });

  const createSchema = body.type === "temporary" ? tempUser : base;
  const result = createSchema.safeParse(body);
  if (!result.success) {
    throw new HttpError(
      400,
      result.error.issues.flatMap((issue) => issue.message).join(", ")
    );
  }

  userStore.createUser({ ...result.data });
  return res.redirect(`/admin/manage/create-user?created=true`);
});

router.get("/view-user/:token", (req, res) => {
  const user = userStore.getUser(req.params.token);
  if (!user) throw new HttpError(404, "User not found");
  res.render("admin_view-user", { user });
});

router.get("/list-users", (req, res) => {
  const sort = parseSort(req.query.sort) || ["sumTokens", "createdAt"];
  const requestedPageSize =
    Number(req.query.perPage) || Number(req.cookies.perPage) || 20;
  const perPage = Math.max(1, Math.min(1000, requestedPageSize));
  const users = userStore
    .getUsers()
    .map((user) => {
      const sums = getSumsForUser(user);
      return { ...user, ...sums };
    })
    .sort(sortBy(sort, false));

  const page = Number(req.query.page) || 1;
  const { items, ...pagination } = paginate(users, page, perPage);

  return res.render("admin_list-users", {
    sort: sort.join(","),
    users: items,
    ...pagination,
  });
});

router.get("/import-users", (_req, res) => {
  res.render("admin_import-users");
});

router.post("/import-users", upload.single("users"), (req, res) => {
  if (!req.file) throw new HttpError(400, "No file uploaded");

  const data = JSON.parse(req.file.buffer.toString());
  const result = z.array(UserPartialSchema).safeParse(data.users);
  if (!result.success) throw new HttpError(400, result.error.toString());

  const upserts = result.data.map((user) => userStore.upsertUser(user));
  req.session.flash = {
    type: "success",
    message: `${upserts.length} users imported`,
  };
  res.redirect("/admin/manage/import-users");
});

router.get("/export-users", (_req, res) => {
  res.render("admin_export-users");
});

router.get("/export-users.json", (_req, res) => {
  const users = userStore.getUsers();
  res.setHeader("Content-Disposition", "attachment; filename=users.json");
  res.setHeader("Content-Type", "application/json");
  res.send(JSON.stringify({ users }, null, 2));
});

router.get("/", (_req, res) => {
  res.render("admin_index");
});

router.post("/edit-user/:token", (req, res) => {
  const result = UserPartialSchema.safeParse({
    ...req.body,
    token: req.params.token,
  });
  if (!result.success) {
    throw new HttpError(
      400,
      result.error.issues.flatMap((issue) => issue.message).join(", ")
    );
  }

  userStore.upsertUser(result.data);
  return res.status(200).json({ success: true });
});

router.post("/reactivate-user/:token", (req, res) => {
  const user = userStore.getUser(req.params.token);
  if (!user) throw new HttpError(404, "User not found");

  userStore.upsertUser({
    token: user.token,
    disabledAt: null,
    disabledReason: null,
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

  userStore.refreshQuota(user.token);
  req.session.flash = {
    type: "success",
    message: "User's quota was refreshed",
  };
  return res.redirect(`/admin/manage/view-user/${user.token}`);
});

router.post("/maintenance", (req, res) => {
  const action = req.body.action;
  let flash = { type: "", message: "" };
  switch (action) {
    case "recheck": {
      keyPool.recheck("openai");
      keyPool.recheck("anthropic");
      const size = keyPool
        .list()
        .filter((k) => k.service !== "google-ai").length;
      flash.type = "success";
      flash.message = `Scheduled recheck of ${size} keys for OpenAI and Anthropic.`;
      break;
    }
    case "resetQuotas": {
      const users = userStore.getUsers();
      users.forEach((user) => userStore.refreshQuota(user.token));
      const { claude, gpt4, turbo } = config.tokenQuota;
      flash.type = "success";
      flash.message = `All users' token quotas reset to ${turbo} (Turbo), ${gpt4} (GPT-4), ${claude} (Claude).`;
      break;
    }
    case "resetCounts": {
      const users = userStore.getUsers();
      users.forEach((user) => userStore.resetUsage(user.token));
      flash.type = "success";
      flash.message = `All users' token usage records reset.`;
      break;
    }
    default: {
      throw new HttpError(400, "Invalid action");
    }
  }

  req.session.flash = flash;

  return res.redirect(`/admin/manage`);
});

router.get("/download-stats", (_req, res) => {
  return res.render("admin_download-stats");
});

router.post("/generate-stats", (req, res) => {
  const body = req.body;

  const valid = z
    .object({
      anon: z.coerce.boolean().optional().default(false),
      sort: z.string().optional().default("prompts"),
      maxUsers: z.coerce
        .number()
        .int()
        .min(5)
        .max(1000)
        .optional()
        .default(1000),
      tableType: z.enum(["code", "markdown"]).optional().default("markdown"),
      format: z
        .string()
        .optional()
        .default("# Stats\n{{header}}\n{{stats}}\n{{time}}"),
    })
    .strict()
    .safeParse(body);

  if (!valid.success) {
    throw new HttpError(
      400,
      valid.error.issues.flatMap((issue) => issue.message).join(", ")
    );
  }

  const { anon, sort, format, maxUsers, tableType } = valid.data;
  const users = userStore.getUsers();

  let totalTokens = 0;
  let totalCost = 0;
  let totalPrompts = 0;
  let totalIps = 0;

  const lines = users
    .map((u) => {
      const sums = getSumsForUser(u);
      totalTokens += sums.sumTokens;
      totalCost += sums.sumCost;
      totalPrompts += u.promptCount;
      totalIps += u.ip.length;

      const getName = (u: User) => {
        const id = `...${u.token.slice(-5)}`;
        const banned = !!u.disabledAt;
        let nick = anon || !u.nickname ? "Anonymous" : u.nickname;

        if (tableType === "markdown") {
          nick = banned ? `~~${nick}~~` : nick;
          return `${nick.slice(0, 18)} | ${id}`;
        } else {
          // Strikethrough doesn't work within code blocks
          const dead = !!u.disabledAt ? "[dead] " : "";
          nick = `${dead}${nick}`;
          return `${nick.slice(0, 18).padEnd(18)} ${id}`.padEnd(27);
        }
      };

      const user = getName(u);
      const prompts = `${u.promptCount} proompts`.padEnd(14);
      const ips = `${u.ip.length} IPs`.padEnd(8);
      const tokens = `${sums.prettyUsage} tokens`.padEnd(30);
      const sortField = sort === "prompts" ? u.promptCount : sums.sumTokens;
      return { user, prompts, ips, tokens, sortField };
    })
    .sort((a, b) => b.sortField - a.sortField)
    .map(({ user, prompts, ips, tokens }, i) => {
      const pos = tableType === "markdown" ? (i + 1 + ".").padEnd(4) : "";
      return `${pos}${user} | ${prompts} | ${ips} | ${tokens}`;
    })
    .slice(0, maxUsers);

  const strTotalPrompts = `${totalPrompts} proompts`;
  const strTotalIps = `${totalIps} IPs`;
  const strTotalTokens = `${prettyTokens(totalTokens)} tokens`;
  const strTotalCost = `US$${totalCost.toFixed(2)} cost`;
  const header = `!!!Note ${users.length} users | ${strTotalPrompts} | ${strTotalIps} | ${strTotalTokens} | ${strTotalCost}`;
  const time = `\n-> *(as of ${new Date().toISOString()})* <-`;

  let table = [];
  table.push(lines.join("\n"));

  if (valid.data.tableType === "markdown") {
    table = ["User||Prompts|IPs|Usage", "---|---|---|---|---", ...table];
  } else {
    table = ["```text", ...table, "```"];
  }

  const result = format
    .replace("{{header}}", header)
    .replace("{{stats}}", table.join("\n"))
    .replace("{{time}}", time);

  res.setHeader(
    "Content-Disposition",
    `attachment; filename=proxy-stats-${new Date().toISOString()}.md`
  );
  res.setHeader("Content-Type", "text/markdown");
  res.send(result);
});

function getSumsForUser(user: User) {
  const sums = MODEL_FAMILIES.reduce(
    (s, model) => {
      const tokens = user.tokenCounts[model] ?? 0;
      s.sumTokens += tokens;
      s.sumCost += getTokenCostUsd(model, tokens);
      return s;
    },
    { sumTokens: 0, sumCost: 0, prettyUsage: "" }
  );
  sums.prettyUsage = `${prettyTokens(sums.sumTokens)} ($${sums.sumCost.toFixed(
    2
  )})`;
  return sums;
}

export { router as usersWebRouter };
