import { doubleCsrf } from "csrf-csrf";
import { v4 as uuid } from "uuid";
import express from "express";

const CSRF_SECRET = uuid();

const { generateToken, doubleCsrfProtection } = doubleCsrf({
  getSecret: () => CSRF_SECRET,
  cookieName: "csrf",
  cookieOptions: { sameSite: "strict", path: "/" },
  getTokenFromRequest: (req) => {
    const val = req.body["_csrf"] || req.query["_csrf"];
    delete req.body["_csrf"];
    return val;
  },
});

const injectCsrfToken: express.RequestHandler = (req, res, next) => {
  res.locals.csrfToken = generateToken(res, req);
  // force generation of new token on back button
  // TODO: implement session-based CSRF tokens
  res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
  next();
};

export { injectCsrfToken, doubleCsrfProtection as checkCsrfToken };
