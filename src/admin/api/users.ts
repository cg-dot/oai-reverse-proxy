import { Router } from "express";
import { z } from "zod";
import * as userStore from "../../shared/users/user-store";
import { parseSort, sortBy } from "../../shared/utils";
import { UserPartialSchema, UserSchema } from "../../shared/users/schema";

const router = Router();

/**
 * Returns a list of all users, sorted by prompt count and then last used time.
 * GET /admin/users
 */
router.get("/", (req, res) => {
  const sort = parseSort(req.query.sort) || ["promptCount", "lastUsedAt"];
  const users = userStore.getUsers().sort(sortBy(sort, false));
  res.json({ users, count: users.length });
});

/**
 * Returns the user with the given token.
 * GET /admin/users/:token
 */
router.get("/:token", (req, res) => {
  const user = userStore.getUser(req.params.token);
  if (!user) {
    return res.status(404).json({ error: "Not found" });
  }
  res.json(user);
});

/**
 * Creates a new user.
 * Optionally accepts a JSON body containing `type`, and for temporary-type
 * users, `tokenLimits` and `expiresAt` fields.
 * Returns the created user's token.
 * POST /admin/users
 */
router.post("/", (req, res) => {
  const body = req.body;

  const base = z.object({
    type: UserSchema.shape.type.exclude(["temporary"]).default("normal"),
  });
  const tempUser = base
    .extend({
      type: z.literal("temporary"),
      expiresAt: UserSchema.shape.expiresAt,
      tokenLimits: UserSchema.shape.tokenLimits,
    })
    .required();

  const schema = z.union([base, tempUser]);
  const result = schema.safeParse(body);
  if (!result.success) {
    return res.status(400).json({ error: result.error });
  }

  const token = userStore.createUser({ ...result.data });
  res.json({ token });
});

/**
 * Updates the user with the given token, creating them if they don't exist.
 * Accepts a JSON body containing at least one field on the User type.
 * Returns the upserted user.
 * PUT /admin/users/:token
 */
router.put("/:token", (req, res) => {
  const result = UserPartialSchema.safeParse({
    ...req.body,
    token: req.params.token,
  });
  if (!result.success) {
    return res.status(400).json({ error: result.error });
  }
  userStore.upsertUser(result.data);
  res.json(userStore.getUser(req.params.token));
});

/**
 * Bulk-upserts users given a list of User updates.
 * Accepts a JSON body with the field `users` containing an array of updates.
 * Returns an object containing the upserted users and the number of upserts.
 * PUT /admin/users
 */
router.put("/", (req, res) => {
  const result = z.array(UserPartialSchema).safeParse(req.body.users);
  if (!result.success) {
    return res.status(400).json({ error: result.error });
  }
  const upserts = result.data.map((user) => userStore.upsertUser(user));
  res.json({ upserted_users: upserts, count: upserts.length });
});

/**
 * Disables the user with the given token. Optionally accepts a `disabledReason`
 * query parameter.
 * Returns the disabled user.
 * DELETE /admin/users/:token
 */
router.delete("/:token", (req, res) => {
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

export { router as usersApiRouter };
