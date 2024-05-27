import type { Request, Response, RequestHandler } from "express";
import { config } from "../config";
import { authenticate, getUser } from "../shared/users/user-store";
import { sendErrorToClient } from "./middleware/response/error-generator";

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
    const ip = req.risuToken?.length
      ? `risu${req.risuToken}-${req.ip}`
      : req.ip;

    const { user, result } = authenticate(token, ip);

    switch (result) {
      case "success":
        req.user = user;
        return next();
      case "limited":
        return sendError(
          req,
          res,
          403,
          `Forbidden: no more IP addresses allowed for this user token`,
          { currentIp: ip, maxIps: user?.maxIps }
        );
      case "disabled":
        const bannedUser = getUser(token);
        if (bannedUser?.disabledAt) {
          const reason = bannedUser.disabledReason || "User token disabled";
          return sendError(req, res, 403, `Forbidden: ${reason}`);
        }
    }
  }

  sendError(req, res, 401, "Unauthorized");
};

function sendError(
  req: Request,
  res: Response,
  status: number,
  message: string,
  data: any = {}
) {
  const isPost = req.method === "POST";
  const hasBody = isPost && req.body;
  const hasModel = hasBody && req.body.model;

  if (!hasModel) {
    return res.status(status).json({ error: message });
  }

  sendErrorToClient({
    req,
    res,
    options: {
      title: `Proxy gatekeeper error (HTTP ${status})`,
      message,
      format: "unknown",
      statusCode: status,
      reqId: req.id,
      obj: data,
    },
  });
}
