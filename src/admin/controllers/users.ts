import { Router } from "express";
import { Query } from "express-serve-static-core";
import multer from "multer";
import { z } from "zod";
import * as userStore from "../../proxy/auth/user-store";

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

const usersRouter = Router();

export const UserSchema = z
  .object({
    ip: z.array(z.string()).optional(),
    type: z.enum(["normal", "special"]).optional(),
    promptCount: z.number().optional(),
    tokenCount: z.number().optional(),
    createdAt: z.number().optional(),
    lastUsedAt: z.number().optional(),
    disabledAt: z.number().optional(),
    disabledReason: z.string().optional(),
  })
  .strict();

const UserSchemaWithToken = UserSchema.extend({
  token: z.string(),
}).strict();

function paginate(set: unknown[], page: number, pageSize: number = 20) {
  return {
    page,
    pageCount: Math.ceil(set.length / pageSize),
    items: set.slice((page - 1) * pageSize, page * pageSize),
    nextPage: page * pageSize < set.length ? page + 1 : null,
    prevPage: page > 1 ? page - 1 : null,
  };
}

function parseSort(sort: Query["sort"]) {
  if (!sort) return null;
  if (typeof sort === "string") return sort.split(",");
  if (Array.isArray(sort)) return sort.splice(3) as string[];
  return null;
}

function sortBy(fields: string[], asc = true) {
  return (a: any, b: any) => {
    for (const field of fields) {
      if (a[field] !== b[field]) {
        // always sort nulls to the end
        if (a[field] == null) return 1;
        if (b[field] == null) return -1;

        const valA = Array.isArray(a[field]) ? a[field].length : a[field];
        const valB = Array.isArray(b[field]) ? b[field].length : b[field];

        const result = valA < valB ? -1 : 1;
        return asc ? result : -result;
      }
    }
    return 0;
  };
}

function isFromUi(req: any) {
  return req.accepts("json", "html") === "html";
}

// UI-specific routes
usersRouter.get("/create-user", (req, res) => {
  const recentUsers = userStore
    .getUsers()
    .sort(sortBy(["createdAt"], false))
    .slice(0, 5);
  res.render("admin/create-user", {
    recentUsers,
    newToken: !!req.query.created,
  });
});

usersRouter.get("/import-users", (req, res) => {
  const imported = Number(req.query.imported) || 0;
  res.render("admin/import-users", { imported });
});

usersRouter.post("/import-users", upload.single("users"), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: "No file uploaded" });
  }
  const data = JSON.parse(req.file.buffer.toString());
  const result = z.array(UserSchemaWithToken).safeParse(data.users);
  if (!result.success) {
    return res.status(400).json({ error: result.error });
  }
  const upserts = result.data.map((user) => userStore.upsertUser(user));
  res.redirect(`/admin/users/import-users?imported=${upserts.length}`);
});

usersRouter.get("/export-users", (req, res) => {
  const users = userStore.getUsers();
  res.render("admin/export-users", { users });
});

// API routes
/**
 * Returns a list of all users, sorted by prompt count and then last used time.
 * GET /admin/users
 */
usersRouter.get("/", (req, res) => {
  const sort = parseSort(req.query.sort) || ["promptCount", "lastUsedAt"];
  const users = userStore.getUsers().sort(sortBy(sort, false));

  if (isFromUi(req)) {
    const page = Number(req.query.page) || 1;
    const { items, ...pagination } = paginate(users, page);

    return res.render("admin/list-users", {
      sort: sort.join(","),
      users: items,
      ...pagination,
    });
  }

  res.json({ users, count: users.length });
});

/**
 * Returns the user with the given token.
 * GET /admin/users/:token
 */
usersRouter.get("/:token", (req, res) => {
  const user = userStore.getUser(req.params.token);
  if (!user) {
    return res.status(404).json({ error: "Not found" });
  }
  res.json(user);
});

/**
 * Creates a new user.
 * Returns the created user's token.
 * POST /admin/users
 */
usersRouter.post("/", (req, res) => {
  const token = userStore.createUser();
  if (isFromUi(req)) {
    return res.redirect(`/admin/users/create-user?created=true`);
  }
  res.json({ token });
});

/**
 * Updates the user with the given token, creating them if they don't exist.
 * Accepts a JSON body containing at least one field on the User type.
 * Returns the upserted user.
 * PUT /admin/users/:token
 */
usersRouter.put("/:token", (req, res) => {
  const result = UserSchema.safeParse(req.body);
  if (!result.success) {
    return res.status(400).json({ error: result.error });
  }
  userStore.upsertUser({ ...result.data, token: req.params.token });
  res.json(userStore.getUser(req.params.token));
});

/**
 * Bulk-upserts users given a list of User updates.
 * Accepts a JSON body with the field `users` containing an array of updates.
 * Returns an object containing the upserted users and the number of upserts.
 * PUT /admin/users
 */
usersRouter.put("/", (req, res) => {
  const result = z.array(UserSchemaWithToken).safeParse(req.body.users);
  if (!result.success) {
    return res.status(400).json({ error: result.error });
  }
  const upserts = result.data.map((user) => userStore.upsertUser(user));
  res.json({
    upserted_users: upserts,
    count: upserts.length,
  });
});

/**
 * Disables the user with the given token. Optionally accepts a `disabledReason`
 * query parameter.
 * Returns the disabled user.
 * DELETE /admin/users/:token
 */
usersRouter.delete("/:token", (req, res) => {
  const user = userStore.getUser(req.params.token);
  const disabledReason = z
    .string()
    .optional()
    .safeParse(req.query.disabledReason);
  if (!disabledReason.success) {
    return res.status(400).json({ error: disabledReason.error });
  }
  if (!user) {
    return res.status(404).json({ error: "Not found" });
  }
  userStore.disableUser(req.params.token, disabledReason.data);
  res.json(userStore.getUser(req.params.token));
});

export { usersRouter };
