import { ZodType, z } from "zod";
import type { ModelFamily } from "../models";
import { makeOptionalPropsNullable } from "../utils";

export const tokenCountsSchema: ZodType<UserTokenCounts> = z
  .object({
    turbo: z.number().optional(),
    gpt4: z.number().optional(),
    "gpt4-32k": z.number().optional().default(0),
    claude: z.number().optional(),
  })
  .refine(zodModelFamilyRefinement, {
    message:
      "If provided, a tokenCounts object must include all model families",
  }) as ZodType<UserTokenCounts>; // refinement ensures the type correctness but zod doesn't know that

export const UserSchema = z
  .object({
    /** User's personal access token. */
    token: z.string(),
    /** IP addresses the user has connected from. */
    ip: z.array(z.string()),
    /** User's nickname. */
    nickname: z.string().max(80).optional(),
    /**
     * The user's privilege level.
     * - `normal`: Default role. Subject to usual rate limits and quotas.
     * - `special`: Special role. Higher quotas and exempt from
     *   auto-ban/lockout.
     **/
    type: z.enum(["normal", "special", "temporary"]),
    /** Number of prompts the user has made. */
    promptCount: z.number(),
    /**
     * @deprecated Use `tokenCounts` instead.
     * Never used; retained for backwards compatibility.
     */
    tokenCount: z.any().optional(),
    /** Number of tokens the user has consumed, by model family. */
    tokenCounts: tokenCountsSchema,
    /** Maximum number of tokens the user can consume, by model family. */
    tokenLimits: tokenCountsSchema,
    /** Time at which the user was created. */
    createdAt: z.number(),
    /** Time at which the user last connected. */
    lastUsedAt: z.number().optional(),
    /** Time at which the user was disabled, if applicable. */
    disabledAt: z.number().optional(),
    /** Reason for which the user was disabled, if applicable. */
    disabledReason: z.string().optional(),
    /** Time at which the user will expire and be disabled (for temp users). */
    expiresAt: z.number().optional(),
    /** The user's maximum number of IP addresses; supercedes global max. */
    maxIps: z.coerce.number().int().min(0).optional(),
  })
  .strict();

/**
 * Variant of `UserSchema` which allows for partial updates, and makes any
 * optional properties on the base schema nullable. Null values are used to
 * indicate that the property should be deleted from the user object.
 */
export const UserPartialSchema = makeOptionalPropsNullable(UserSchema)
  .partial()
  .extend({ token: z.string() });

// gpt4-32k was added after the initial release, so this tries to allow for
// data imported from older versions of the app which may be missing the
// new model family.
// Otherwise, all model families must be present.
function zodModelFamilyRefinement(data: Record<string, number>) {
  const keys = Object.keys(data).sort();
  const validSets = [
    ["claude", "gpt4", "turbo"],
    ["claude", "gpt4", "gpt4-32k", "turbo"],
  ];
  return validSets.some((set) => keys.join(",") === set.join(","));
}

export type UserTokenCounts = {
  [K in Exclude<ModelFamily, "gpt4-32k">]: number;
} & {
  [K in "gpt4-32k"]?: number | null; // null is not quite right but is more strict than undefined with +=
};
export type User = z.infer<typeof UserSchema>;
export type UserUpdate = z.infer<typeof UserPartialSchema>;
