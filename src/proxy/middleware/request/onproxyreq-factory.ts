import {
  applyQuotaLimits,
  blockZoomerOrigins,
  checkModelFamily,
  HPMRequestCallback,
  stripHeaders,
} from "./index";

type ProxyReqHandlerFactoryOptions = { pipeline: HPMRequestCallback[] };

/**
 * Returns an http-proxy-middleware request handler that runs the given set of
 * onProxyReq callback functions in sequence.
 *
 * These will run each time a request is proxied, including on automatic retries
 * by the queue after encountering a rate limit.
 */
export const createOnProxyReqHandler = ({
  pipeline,
}: ProxyReqHandlerFactoryOptions): HPMRequestCallback => {
  const callbackPipeline = [
    checkModelFamily,
    applyQuotaLimits,
    blockZoomerOrigins,
    stripHeaders,
    ...pipeline,
  ];
  return (proxyReq, req, res, options) => {
    // The streaming flag must be set before any other onProxyReq handler runs,
    // as it may influence the behavior of subsequent handlers.
    // Image generation requests can't be streamed.
    // TODO: this flag is set in too many places
    req.isStreaming =
      req.isStreaming || req.body.stream === true || req.body.stream === "true";
    req.body.stream = req.isStreaming;

    try {
      for (const fn of callbackPipeline) {
        fn(proxyReq, req, res, options);
      }
    } catch (error) {
      proxyReq.destroy(error);
    }
  };
};
