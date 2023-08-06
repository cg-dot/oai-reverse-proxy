import { Request, Response, RequestHandler } from "express";
import { config } from "../config";

const ADMIN_KEY = config.adminKey;
const failedAttempts = new Map<string, number>();

export const auth: RequestHandler = (req, res, next) => {
  const bearerToken = req.headers.authorization?.slice("Bearer ".length);
  const cookieToken = req.cookies["admin-token"];
  const token = bearerToken ?? cookieToken;
  const attempts = failedAttempts.get(req.ip) ?? 0;

  if (!token) {
    return res.redirect("/admin/login");
  }

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

  if (token !== ADMIN_KEY) {
    req.log.warn(
      { ip: req.ip, attempts, token },
      `Attempted admin request with invalid token`
    );
    return handleFailedLogin(req, res);
  }

  req.log.info({ ip: req.ip }, `Admin request authorized`);
  next();
};

function handleFailedLogin(req: Request, res: Response) {
  const attempts = failedAttempts.get(req.ip) ?? 0;
  const newAttempts = attempts + 1;
  failedAttempts.set(req.ip, newAttempts);
  if (req.accepts("json", "html") === "json") {
    return res.status(401).json({ error: "Unauthorized" });
  }
  return res.redirect("/admin/login?failed=true");
}
