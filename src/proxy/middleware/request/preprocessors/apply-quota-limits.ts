import { hasAvailableQuota } from "../../../../shared/users/user-store";
import { isImageGenerationRequest, isTextGenerationRequest } from "../../common";
import { HPMRequestCallback } from "../index";

export class QuotaExceededError extends Error {
  public quotaInfo: any;
  constructor(message: string, quotaInfo: any) {
    super(message);
    this.name = "QuotaExceededError";
    this.quotaInfo = quotaInfo;
  }
}

export const applyQuotaLimits: HPMRequestCallback = (_proxyReq, req) => {
  const subjectToQuota =
    isTextGenerationRequest(req) || isImageGenerationRequest(req);
  if (!subjectToQuota || !req.user) return;

  const requestedTokens = (req.promptTokens ?? 0) + (req.outputTokens ?? 0);
  if (
    !hasAvailableQuota({
      userToken: req.user.token,
      model: req.body.model,
      api: req.outboundApi,
      requested: requestedTokens,
    })
  ) {
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
