import { Request, Response, NextFunction } from "express";
import ipaddr, { IPv4, IPv6 } from "ipaddr.js";
import { logger } from "../logger";

const log = logger.child({ module: "cidr" });

type IpCheckMiddleware = ((
  req: Request,
  res: Response,
  next: NextFunction
) => void) & {
  ranges: string[];
  updateRanges: (ranges: string[] | string) => void;
};

export const whitelists = new Map<string, IpCheckMiddleware>();
export const blacklists = new Map<string, IpCheckMiddleware>();

export function parseCidrs(cidrs: string[] | string): [IPv4 | IPv6, number][] {
  const list = Array.isArray(cidrs)
    ? cidrs
    : cidrs.split(",").map((s) => s.trim());
  return list
    .map((input) => {
      try {
        if (input.includes("/")) {
          return ipaddr.parseCIDR(input);
        } else {
          const ip = ipaddr.parse(input);
          return ipaddr.parseCIDR(
            `${input}/${ip.kind() === "ipv4" ? 32 : 128}`
          );
        }
      } catch (e) {
        log.error({ input, error: e.message }, "Invalid CIDR mask; skipping");
        return null;
      }
    })
    .filter((cidr): cidr is [IPv4 | IPv6, number] => cidr !== null);
}

export function createWhitelistMiddleware(
  name: string,
  base: string[] | string
) {
  let cidrs: string[] = [];
  let matchers: [IPv4 | IPv6, number][] = [];

  const middleware = (req: Request, res: Response, next: NextFunction) => {
    const ip = ipaddr.process(req.ip);
    const allowed = matchers.some((cidr) => ip.match(cidr));
    if (allowed) {
      return next();
    }
    req.log.warn({ ip: req.ip, list: name }, "Request denied by whitelist");
    res.status(403).json({ error: `Forbidden (by ${name})` });
  };
  middleware.ranges = [] as string[];
  middleware.updateRanges = (ranges: string[] | string) => {
    cidrs = Array.isArray(ranges) ? ranges.slice() : [ranges];
    matchers = parseCidrs(cidrs);
    log.info({ list: name, matchers }, "IP whitelist configured");
    middleware.ranges = cidrs;
  };

  middleware.updateRanges(base);

  whitelists.set(name, middleware);
  return middleware;
}

export function createBlacklistMiddleware(
  name: string,
  base: string[] | string
) {
  let cidrs: string[] = [];
  let matchers: [IPv4 | IPv6, number][] = [];

  const middleware = (req: Request, res: Response, next: NextFunction) => {
    const ip = ipaddr.process(req.ip);
    const denied = matchers.some((cidr) => ip.match(cidr));
    if (denied) {
      req.log.warn({ ip: req.ip, list: name }, "Request denied by blacklist");
      return res.status(403).json({ error: `Forbidden (by ${name})` });
    }
    return next();
  };
  middleware.ranges = [] as string[];
  middleware.updateRanges = (ranges: string[] | string) => {
    cidrs = Array.isArray(ranges) ? ranges.slice() : [ranges];
    matchers = parseCidrs(cidrs);
    log.info({ list: name, matchers }, "IP blacklist configured");
    middleware.ranges = cidrs;
  };
  middleware.updateRanges(base);

  blacklists.set(name, middleware);
  return middleware;
}
