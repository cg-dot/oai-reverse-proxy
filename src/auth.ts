import type { Request, Response, NextFunction } from "express";

const PROXY_KEY = process.env.PROXY_KEY;

export function auth(req: Request, res: Response, next: NextFunction) {
  if (!PROXY_KEY) {
    next();
    return;
  }
  if (req.headers.authorization === `Bearer ${PROXY_KEY}`) {
    delete req.headers.authorization;
    next();
  } else {
    res.status(401).json({ error: "Unauthorized" });
  }
}
