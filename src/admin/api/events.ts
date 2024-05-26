import { Router } from "express";
import { z } from "zod";
import { encodeCursor, decodeCursor } from "../../shared/utils";
import { eventsRepo } from "../../shared/database/repos/event";

const router = Router();

/**
 * Returns events for the given user token.
 * GET /admin/events/:token
 * @query first - The number of events to return.
 * @query after - The cursor to start returning events from (exclusive).
 */
router.get("/:token", (req, res) => {
  const schema = z.object({
    token: z.string(),
    first: z.coerce.number().int().positive().max(200).default(25),
    after: z
      .string()
      .optional()
      .transform((v) => {
        try {
          return decodeCursor(v);
        } catch {
          return null;
        }
      })
      .nullable(),
    sort: z.string().optional(),
  });
  const args = schema.safeParse({ ...req.params, ...req.query });
  if (!args.success) {
    return res.status(400).json({ error: args.error });
  }

  const data = eventsRepo
    .getUserEvents(args.data.token, {
      limit: args.data.first,
      cursor: args.data.after,
    })
    .map((e) => ({ node: e, cursor: encodeCursor(e.date) }));

  res.json({
    data,
    endCursor: data[data.length - 1]?.cursor,
  });
});

export { router as eventsApiRouter };
