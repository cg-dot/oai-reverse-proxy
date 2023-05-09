import { ExpressHttpProxyReqCallback, isCompletionRequest } from ".";

/**
 * If a stream is requested, mark the request as such so the response middleware
 * knows to use the alternate EventSource response handler.
 * Kobold requests can't currently be streamed as they use a different event
 * format than the OpenAI API and we need to rewrite the events as they come in,
 * which I have not yet implemented.
 */
export const checkStreaming: ExpressHttpProxyReqCallback = (_proxyReq, req) => {
  const streamableApi = req.api !== "kobold";
  if (isCompletionRequest(req) && req.body?.stream) {
    if (!streamableApi) {
      req.log.warn(
        { api: req.api, key: req.key?.hash },
        `Streaming requested, but ${req.api} streaming is not supported.`
      );
      req.body.stream = false;
      return;
    }
    req.body.stream = true;
    req.isStreaming = true;
  }
};
