import { Router } from "express";
import ipaddr from "ipaddr.js";
import multer from "multer";
import { z } from "zod";
import { config } from "../../config";
import { HttpError } from "../../shared/errors";
import * as userStore from "../../shared/users/user-store";
import { parseSort, sortBy, paginate } from "../../shared/utils";
import { keyPool } from "../../shared/key-management";
import { LLMService, MODEL_FAMILIES } from "../../shared/models";
import { getTokenCostUsd, prettyTokens } from "../../shared/stats";
import {
  User,
  UserPartialSchema,
  UserSchema,
  UserTokenCounts,
} from "../../shared/users/schema";
import { getLastNImages } from "../../shared/file-storage/image-history";
import { blacklists, parseCidrs, whitelists } from "../../shared/cidr";

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

router.get("/anti-abuse", (_req, res) => {
  const wl = [...whitelists.entries()];
  const bl = [...blacklists.entries()];

  res.render("admin_anti-abuse", {
    captchaMode: config.captchaMode,
    difficulty: config.powDifficultyLevel,
    whitelists: wl.map((w) => ({
      name: w[0],
      mode: "whitelist",
      ranges: w[1].ranges,
    })),
    blacklists: bl.map((b) => ({
      name: b[0],
      mode: "blacklist",
      ranges: b[1].ranges,
    })),
  });
});

router.post("/cidr", (req, res) => {
  const body = req.body;
  const valid = z
    .object({
      action: z.enum(["add", "remove"]),
      mode: z.enum(["whitelist", "blacklist"]),
      name: z.string().min(1),
      mask: z.string().min(1),
    })
    .safeParse(body);

  if (!valid.success) {
    throw new HttpError(
      400,
      valid.error.issues.flatMap((issue) => issue.message).join(", ")
    );
  }

  const { mode, name, mask } = valid.data;
  const list = (mode === "whitelist" ? whitelists : blacklists).get(name);
  if (!list) {
    throw new HttpError(404, "List not found");
  }
  if (valid.data.action === "remove") {
    const newRanges = new Set(list.ranges);
    newRanges.delete(mask);
    list.updateRanges([...newRanges]);
    req.session.flash = {
      type: "success",
      message: `${mode} ${name} updated`,
    };
    return res.redirect("/admin/manage/anti-abuse");
  } else if (valid.data.action === "add") {
    const result = parseCidrs(mask);
    if (result.length === 0) {
      throw new HttpError(400, "Invalid CIDR mask");
    }

    const newRanges = new Set([...list.ranges, mask]);
    list.updateRanges([...newRanges]);
    req.session.flash = {
      type: "success",
      message: `${mode} ${name} updated`,
    };
    return res.redirect("/admin/manage/anti-abuse");
  }
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
      const checkable: LLMService[] = ["openai", "anthropic", "aws", "azure"];
      checkable.forEach((s) => keyPool.recheck(s));
      const keyCount = keyPool
        .list()
        .filter((k) => checkable.includes(k.service)).length;

      flash.type = "success";
      flash.message = `Scheduled recheck of ${keyCount} keys.`;
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
    case "downloadImageMetadata": {
      const data = JSON.stringify(
        {
          exportedAt: new Date().toISOString(),
          generations: getLastNImages(),
        },
        null,
        2
      );
      res.setHeader(
        "Content-Disposition",
        `attachment; filename=image-metadata-${new Date().toISOString()}.json`
      );
      res.setHeader("Content-Type", "application/json");
      return res.send(data);
    }
    case "expireTempTokens": {
      const users = userStore.getUsers();
      const temps = users.filter((u) => u.type === "temporary");
      temps.forEach((user) => {
        user.expiresAt = Date.now();
        userStore.upsertUser(user);
      });
      flash.type = "success";
      flash.message = `${temps.length} temporary users marked for expiration.`;
      break;
    }
    case "cleanTempTokens": {
      const users = userStore.getUsers();
      const disabledTempUsers = users.filter(
        (u) => u.type === "temporary" && u.expiresAt && u.expiresAt < Date.now()
      );
      disabledTempUsers.forEach((user) => {
        user.disabledAt = 1; //will be cleaned up by the next cron job
        userStore.upsertUser(user);
      });
      flash.type = "success";
      flash.message = `${disabledTempUsers.length} disabled temporary users marked for cleanup.`;
      break;
    }
    case "setDifficulty": {
      const selected = req.body["pow-difficulty"];
      const valid = ["low", "medium", "high", "extreme"];
      if (!selected || !valid.includes(selected)) {
        throw new HttpError(400, "Invalid difficulty" + selected);
      }
      config.powDifficultyLevel = selected;
      break;
    }
    case "generateTempIpReport": {
      const tempUsers = userStore
        .getUsers()
        .filter((u) => u.type === "temporary");
      const ipv4RangeMap: Map<string, Set<string>> = new Map<
        string,
        Set<string>
      >();
      const ipv6RangeMap: Map<string, Set<string>> = new Map<
        string,
        Set<string>
      >();

      tempUsers.forEach((u) => {
        u.ip.forEach((ip) => {
          try {
            const parsed = ipaddr.parse(ip);
            if (parsed.kind() === "ipv4") {
              const subnet =
                parsed.toNormalizedString().split(".").slice(0, 3).join(".") +
                ".0/24";
              const userSet = ipv4RangeMap.get(subnet) || new Set<string>();
              userSet.add(u.token);
              ipv4RangeMap.set(subnet, userSet);
            } else if (parsed.kind() === "ipv6") {
              const subnet =
                parsed.toNormalizedString().split(":").slice(0, 3).join(":") +
                "::/56";
              const userSet = ipv6RangeMap.get(subnet) || new Set<string>();
              userSet.add(u.token);
              ipv6RangeMap.set(subnet, userSet);
            }
          } catch (e) {
            req.log.warn(
              { ip, error: e.message },
              "Invalid IP address; skipping"
            );
          }
        });
      });

      const ipv4Ranges = Array.from(ipv4RangeMap.entries())
        .map(([subnet, userSet]) => ({
          subnet,
          distinctTokens: userSet.size,
        }))
        .sort((a, b) => b.distinctTokens - a.distinctTokens);

      const ipv6Ranges = Array.from(ipv6RangeMap.entries())
        .map(([subnet, userSet]) => ({
          subnet,
          distinctTokens: userSet.size,
        }))
        .sort((a, b) => {
          if (a.distinctTokens === b.distinctTokens) {
            return a.subnet.localeCompare(b.subnet);
          }
          return b.distinctTokens - a.distinctTokens;
        });

      const data = JSON.stringify(
        {
          exportedAt: new Date().toISOString(),
          ipv4Ranges,
          ipv6Ranges,
        },
        null,
        2
      );

      res.setHeader(
        "Content-Disposition",
        `attachment; filename=temp-ip-report-${new Date().toISOString()}.json`
      );
      res.setHeader("Content-Type", "application/json");
      return res.send(data);
    }
    default: {
      throw new HttpError(400, "Invalid action");
    }
  }

  req.session.flash = flash;
  const referer = req.get("referer");

  return res.redirect(referer || "/admin/manage");
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
