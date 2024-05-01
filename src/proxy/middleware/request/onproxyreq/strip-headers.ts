import { HPMRequestCallback } from "../index";

/**
 * Removes origin and referer headers before sending the request to the API for
 * privacy reasons.
 **/
export const stripHeaders: HPMRequestCallback = (proxyReq) => {
  proxyReq.setHeader("origin", "");
  proxyReq.setHeader("referer", "");
  proxyReq.removeHeader("tailscale-user-login");
  proxyReq.removeHeader("tailscale-user-name");
  proxyReq.removeHeader("tailscale-headers-info");
  proxyReq.removeHeader("tailscale-user-profile-pic")
  proxyReq.removeHeader("cf-connecting-ip");
  proxyReq.removeHeader("forwarded");
  proxyReq.removeHeader("true-client-ip");
  proxyReq.removeHeader("x-forwarded-for");
  proxyReq.removeHeader("x-forwarded-host");
  proxyReq.removeHeader("x-forwarded-proto");
  proxyReq.removeHeader("x-real-ip");
};
