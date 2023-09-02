import { hasAvailableQuota } from "../../../shared/users/user-store";
import { isCompletionRequest } from "../common";
import { ProxyRequestMiddleware } from ".";

export class QuotaExceededError extends Error {
  public quotaInfo: any;
  constructor(message: string, quotaInfo: any) {
    super(message);
    this.name = "QuotaExceededError";
    this.quotaInfo = quotaInfo;
  }
}

export const applyQuotaLimits: ProxyRequestMiddleware = (_proxyReq, req) => {
  if (!isCompletionRequest(req) || !req.user) {
    return;
  }

  const requestedTokens = (req.promptTokens ?? 0) + (req.outputTokens ?? 0);
  if (!hasAvailableQuota(req.user.token, req.body.model, requestedTokens)) {
    throw new QuotaExceededError(
      "You have exceeded your proxy token quota for this model.",
      {
        quota: req.user.tokenLimits,
        used: req.user.tokenCounts,
        requested: requestedTokens,
      }
    );
  }
};
