import type { Request, RequestHandler } from "express";
import { config } from "../config";
import { authenticate, getUser } from "../shared/users/user-store";

const GATEKEEPER = config.gatekeeper;
const PROXY_KEY = config.proxyKey;
const ADMIN_KEY = config.adminKey;

function getProxyAuthorizationFromRequest(req: Request): string | undefined {
  // Anthropic's API uses x-api-key instead of Authorization.  Some clients will
  // pass the _proxy_ key in this header too, instead of providing it as a
  // Bearer token in the Authorization header.  So we need to check both.
  // Prefer the Authorization header if both are present.

  if (req.headers.authorization) {
    const token = req.headers.authorization?.slice("Bearer ".length);
    delete req.headers.authorization;
    return token;
  }

  if (req.headers["x-api-key"]) {
    const token = req.headers["x-api-key"]?.toString();
    delete req.headers["x-api-key"];
    return token;
  }

  return undefined;
}

export const gatekeeper: RequestHandler = (req, res, next) => {
  const token = getProxyAuthorizationFromRequest(req);

  // TODO: Generate anonymous users based on IP address for public or proxy_key
  // modes so that all middleware can assume a user of some sort is present.

  if (ADMIN_KEY && token === ADMIN_KEY) {
    return next();
  }

  if (GATEKEEPER === "none") {
    return next();
  }

  if (GATEKEEPER === "proxy_key" && token === PROXY_KEY) {
    return next();
  }

  if (GATEKEEPER === "user_token" && token) {
    // RisuAI users all come from a handful of aws lambda IPs so we cannot use
    // IP alone to distinguish between them and prevent usertoken sharing.
    // Risu sends a signed token in the request headers with an anonymous user
    // ID that we can instead use to associate requests with an individual.
    const ip = req.risuToken?.length ?
      `risu${req.risuToken}-${req.ip}` :
      req.ip;

    const { user, result } = authenticate(token, ip);

    switch (result) {
      case "success":
        req.user = user;
        return next();
      case "limited":
        return res.status(403).json({
          error: `Forbidden: no more IPs can authenticate with this token`,
        });
      case "disabled":
        const bannedUser = getUser(token);
        if (bannedUser?.disabledAt) {
          const reason = bannedUser.disabledReason || "Token disabled";
          return res.status(403).json({ error: `Forbidden: ${reason}` });
        }
    }
  }

  res.status(401).json({ error: "Unauthorized" });
};
