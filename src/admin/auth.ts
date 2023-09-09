import { Request, Response, RequestHandler } from "express";
import { config } from "../config";

const ADMIN_KEY = config.adminKey;
const failedAttempts = new Map<string, number>();

type AuthorizeParams = { via: "cookie" | "header" };

export const authorize: ({ via }: AuthorizeParams) => RequestHandler =
  ({ via }) =>
  (req, res, next) => {
    const bearerToken = req.headers.authorization?.slice("Bearer ".length);
    const cookieToken = req.session.adminToken;
    const token = via === "cookie" ? cookieToken : bearerToken;
    const attempts = failedAttempts.get(req.ip) ?? 0;

    if (!ADMIN_KEY) {
      req.log.warn(
        { ip: req.ip },
        `Blocked admin request because no admin key is configured`
      );
      return res.status(401).json({ error: "Unauthorized" });
    }

    if (attempts > 5) {
      req.log.warn(
        { ip: req.ip, token: bearerToken },
        `Blocked admin request due to too many failed attempts`
      );
      return res.status(401).json({ error: "Too many attempts" });
    }

    if (token && token === ADMIN_KEY) {
      return next();
    }

    req.log.warn(
      { ip: req.ip, attempts, invalidToken: String(token) },
      `Attempted admin request with invalid token`
    );
    return handleFailedLogin(req, res);
  };

function handleFailedLogin(req: Request, res: Response) {
  const attempts = failedAttempts.get(req.ip) ?? 0;
  const newAttempts = attempts + 1;
  failedAttempts.set(req.ip, newAttempts);
  if (req.accepts("json", "html") === "json") {
    return res.status(401).json({ error: "Unauthorized" });
  }
  delete req.session.adminToken;
  req.session.flash = { type: "error", message: `Invalid admin key.` };
  return res.redirect("/admin/login");
}
