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
          return ipaddr.parseCIDR(input.trim());
        } else {
          const ip = ipaddr.parse(input.trim());
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
  let ranges: Record<string, [IPv4 | IPv6, number][]> = {};

  const middleware: IpCheckMiddleware = (req, res, next) => {
    const ip = ipaddr.process(req.ip);
    const match = ipaddr.subnetMatch(ip, ranges, "none");
    if (match === name) {
      return next();
    } else {
      req.log.warn({ ip: req.ip, list: name }, "Request denied by whitelist");
      res.status(403).json({ error: `Forbidden (by ${name})` });
    }
  };
  middleware.ranges = cidrs;
  middleware.updateRanges = (r: string[] | string) => {
    cidrs = Array.isArray(r) ? r.slice() : [r];
    const parsed = parseCidrs(cidrs);
    ranges = { [name]: parsed };
    middleware.ranges = cidrs;
    log.info({ list: name, ranges }, "IP whitelist configured");
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
  let ranges: Record<string, [IPv4 | IPv6, number][]> = {};

  const middleware: IpCheckMiddleware = (req, res, next) => {
    const ip = ipaddr.process(req.ip);
    const match = ipaddr.subnetMatch(ip, ranges, "none");
    if (match === name) {
      req.log.warn({ ip: req.ip, list: name }, "Request denied by blacklist");
      return res.status(403).json({ error: `Forbidden (by ${name})` });
    } else {
      return next();
    }
  };
  middleware.ranges = cidrs;
  middleware.updateRanges = (r: string[] | string) => {
    cidrs = Array.isArray(r) ? r.slice() : [r];
    const parsed = parseCidrs(cidrs);
    ranges = { [name]: parsed };
    middleware.ranges = cidrs;
    log.info({ list: name, ranges }, "IP blacklist configured");
  };

  middleware.updateRanges(base);

  blacklists.set(name, middleware);
  return middleware;
}
