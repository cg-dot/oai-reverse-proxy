import { RequestHandler } from "express";
import { config } from "../config";
import { getTokenCostUsd, prettyTokens } from "./stats";
import { redactIp } from "./utils";
import * as userStore from "./users/user-store";

export const injectLocals: RequestHandler = (req, res, next) => {
  // config-related locals
  const quota = config.tokenQuota;
  res.locals.quotasEnabled =
    quota.turbo > 0 || quota.gpt4 > 0 || quota.claude > 0;
  res.locals.quota = quota;
  res.locals.nextQuotaRefresh = userStore.getNextQuotaRefresh();
  res.locals.persistenceEnabled = config.gatekeeperStore !== "memory";
  res.locals.usersEnabled = config.gatekeeper === "user_token";
  res.locals.imageGenerationEnabled = config.allowedModelFamilies.some(
    (f) => ["dall-e", "azure-dall-e"].includes(f)
  );
  res.locals.showTokenCosts = config.showTokenCosts;
  res.locals.maxIps = config.maxIpsPerUser;

  // flash messages
  if (req.session.flash) {
    res.locals.flash = req.session.flash;
    delete req.session.flash;
  } else {
    res.locals.flash = null;
  }

  // view helpers
  res.locals.prettyTokens = prettyTokens;
  res.locals.tokenCost = getTokenCostUsd;
  res.locals.redactIp = redactIp;

  next();
};
