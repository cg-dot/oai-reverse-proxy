import { HPMRequestCallback } from "../index";
import { config } from "../../../../config";
import { getModelFamilyForRequest } from "../../../../shared/models";

/**
 * Ensures the selected model family is enabled by the proxy configuration.
 **/
export const checkModelFamily: HPMRequestCallback = (proxyReq, req) => {
  const family = getModelFamilyForRequest(req);
  if (!config.allowedModelFamilies.includes(family)) {
    throw new Error(`Model family ${family} is not permitted on this proxy`);
  }
};
