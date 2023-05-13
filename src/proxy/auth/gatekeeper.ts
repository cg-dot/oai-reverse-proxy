import type { RequestHandler } from "express";
import { config } from "../../config";
import { authenticate, getUser } from "./user-store";

const GATEKEEPER = config.gatekeeper;
const PROXY_KEY = config.proxyKey;
const ADMIN_KEY = config.adminKey;

export const gatekeeper: RequestHandler = (req, res, next) => {
  const token = req.headers.authorization?.slice("Bearer ".length);
  delete req.headers.authorization;

  // TODO: Generate anonymous users based on IP address for public or proxy_key
  // modes so that all middleware can assume a user of some sort is present.

  if (token === ADMIN_KEY) {
    return next();
  }

  if (GATEKEEPER === "none") {
    return next();
  }

  if (GATEKEEPER === "proxy_key" && token === PROXY_KEY) {
    return next();
  }

  if (GATEKEEPER === "user_token" && token) {
    const user = authenticate(token, req.ip);
    if (user) {
      req.user = user;
      return next();
    } else {
      const maybeBannedUser = getUser(token);
      if (maybeBannedUser?.disabledAt) {
        return res.status(403).json({
          error: `Forbidden: ${
            maybeBannedUser.disabledReason || "Token disabled"
          }`,
        });
      }
    }
  }

  res.status(401).json({ error: "Unauthorized" });
};
