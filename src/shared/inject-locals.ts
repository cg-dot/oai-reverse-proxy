import { RequestHandler } from "express";
import sanitize from "sanitize-html";
import { config } from "../config";
import { getTokenCostUsd, prettyTokens } from "./stats";
import * as userStore from "./users/user-store";

export const injectLocals: RequestHandler = (req, res, next) => {
  // config-related locals
  const quota = config.tokenQuota;
  res.locals.quotasEnabled =
    quota.turbo > 0 || quota.gpt4 > 0 || quota.claude > 0;
  res.locals.quota = quota;
  res.locals.nextQuotaRefresh = userStore.getNextQuotaRefresh();
  res.locals.persistenceEnabled = config.gatekeeperStore !== "memory";
  res.locals.showTokenCosts = config.showTokenCosts;

  // flash message
  if (req.query.flash) {
    const content = sanitize(String(req.query.flash))
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
    const match = content.match(/^([a-z]+):(.*)/);
    if (match) {
      res.locals.flash = { type: match[1], message: match[2] };
    } else {
      res.locals.flash = { type: "error", message: content };
    }
  } else {
    res.locals.flash = null;
  }

  // utils
  res.locals.prettyTokens = prettyTokens;
  res.locals.tokenCost = getTokenCostUsd;

  next();
};
