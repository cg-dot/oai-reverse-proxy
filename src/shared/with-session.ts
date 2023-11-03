import cookieParser from "cookie-parser";
import expressSession from "express-session";
import MemoryStore from "memorystore";
import { config, COOKIE_SECRET } from "../config";

const ONE_WEEK = 1000 * 60 * 60 * 24 * 7;

const cookieParserMiddleware = cookieParser(COOKIE_SECRET);

const sessionMiddleware = expressSession({
  secret: COOKIE_SECRET,
  resave: false,
  saveUninitialized: false,
  store: new (MemoryStore(expressSession))({ checkPeriod: ONE_WEEK }),
  cookie: {
    sameSite: "strict",
    maxAge: ONE_WEEK,
    signed: true,
    secure: !config.useInsecureCookies,
  },
});

const withSession = [cookieParserMiddleware, sessionMiddleware];

export { withSession };
