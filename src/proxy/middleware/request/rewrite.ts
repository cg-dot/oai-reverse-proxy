import { Request } from "express";
import { ClientRequest } from "http";
import httpProxy from "http-proxy";
import { ProxyRequestMiddleware } from "./index";

type ProxyReqCallback = httpProxy.ProxyReqCallback<ClientRequest, Request>;
type RewriterOptions = {
  beforeRewrite?: ProxyReqCallback[];
  pipeline: ProxyRequestMiddleware[];
};

export const createOnProxyReqHandler = ({
  beforeRewrite = [],
  pipeline,
}: RewriterOptions): ProxyReqCallback => {
  return (proxyReq, req, res, options) => {
    try {
      for (const validator of beforeRewrite) {
        validator(proxyReq, req, res, options);
      }
    } catch (error) {
      req.log.error(error, "Error while executing proxy request validator");
      proxyReq.destroy(error);
    }

    try {
      for (const rewriter of pipeline) {
        rewriter(proxyReq, req, res, options);
      }
    } catch (error) {
      req.log.error(error, "Error while executing proxy request rewriter");
      proxyReq.destroy(error);
    }
  };
};
