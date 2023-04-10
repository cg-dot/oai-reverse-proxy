import type { ExpressHttpProxyReqCallback } from ".";
import { Key, keys } from "../../keys/key-pool";

/** Add an OpenAI key from the pool to the request. */
export const addKey: ExpressHttpProxyReqCallback = (proxyReq, req) => {
  let assignedKey: Key;
  assignedKey = keys.get(req.body?.model || "gpt-3.5")!;
  req.key = assignedKey;
  proxyReq.setHeader("Authorization", `Bearer ${assignedKey.key}`);
};
