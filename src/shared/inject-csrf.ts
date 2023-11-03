import { doubleCsrf } from "csrf-csrf";
import express from "express";
import { config, COOKIE_SECRET } from "../config";

const { generateToken, doubleCsrfProtection } = doubleCsrf({
  getSecret: () => COOKIE_SECRET,
  cookieName: "csrf",
  cookieOptions: {
    sameSite: "strict",
    path: "/",
    secure: !config.useInsecureCookies,
  },
  getTokenFromRequest: (req) => {
    const val = req.body["_csrf"] || req.query["_csrf"];
    delete req.body["_csrf"];
    return val;
  },
});

const injectCsrfToken: express.RequestHandler = (req, res, next) => {
  const session = req.session;
  if (!session.csrf) {
    session.csrf = generateToken(res, req);
  }
  res.locals.csrfToken = session.csrf;
  next();
};

export { injectCsrfToken, doubleCsrfProtection as checkCsrfToken };
