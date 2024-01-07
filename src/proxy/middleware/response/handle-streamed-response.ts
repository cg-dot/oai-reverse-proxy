import { pipeline } from "stream";
import { promisify } from "util";
import {
  makeCompletionSSE,
  copySseResponseHeaders,
  initializeSseStream,
} from "../../../shared/streaming";
import { enqueue } from "../../queue";
import { decodeResponseBody, RawResponseBodyHandler, RetryableError } from ".";
import { SSEStreamAdapter } from "./streaming/sse-stream-adapter";
import { SSEMessageTransformer } from "./streaming/sse-message-transformer";
import { EventAggregator } from "./streaming/event-aggregator";
import { keyPool } from "../../../shared/key-management";

const pipelineAsync = promisify(pipeline);

/**
 * Consume the SSE stream and forward events to the client. Once the stream is
 * stream is closed, resolve with the full response body so that subsequent
 * middleware can work with it.
 *
 * Typically we would only need of the raw response handlers to execute, but
 * in the event a streamed request results in a non-200 response, we need to
 * fall back to the non-streaming response handler so that the error handler
 * can inspect the error response.
 */
export const handleStreamedResponse: RawResponseBodyHandler = async (
  proxyRes,
  req,
  res
) => {
  const { hash } = req.key!;
  if (!req.isStreaming) {
    throw new Error("handleStreamedResponse called for non-streaming request.");
  }

  if (proxyRes.statusCode! > 201) {
    req.isStreaming = false;
    req.log.warn(
      { statusCode: proxyRes.statusCode, key: hash },
      `Streaming request returned error status code. Falling back to non-streaming response handler.`
    );
    return decodeResponseBody(proxyRes, req, res);
  }

  req.log.debug(
    { headers: proxyRes.headers, key: hash },
    `Starting to proxy SSE stream.`
  );

  // Users waiting in the queue already have a SSE connection open for the
  // heartbeat, so we can't always send the stream headers.
  if (!res.headersSent) {
    copySseResponseHeaders(proxyRes, res);
    initializeSseStream(res);
  }

  const prefersNativeEvents = req.inboundApi === req.outboundApi;
  const contentType = proxyRes.headers["content-type"];

  const adapter = new SSEStreamAdapter({ contentType, api: req.outboundApi });
  const aggregator = new EventAggregator({ format: req.outboundApi });
  const transformer = new SSEMessageTransformer({
    inputFormat: req.outboundApi,
    inputApiVersion: String(req.headers["anthropic-version"]),
    logger: req.log,
    requestId: String(req.id),
    requestedModel: req.body.model,
  })
    .on("originalMessage", (msg: string) => {
      if (prefersNativeEvents) res.write(msg);
    })
    .on("data", (msg) => {
      if (!prefersNativeEvents) res.write(`data: ${JSON.stringify(msg)}\n\n`);
      aggregator.addEvent(msg);
    });

  try {
    await pipelineAsync(proxyRes, adapter, transformer);
    req.log.debug({ key: hash }, `Finished proxying SSE stream.`);
    res.end();
    return aggregator.getFinalResponse();
  } catch (err) {
    if (err instanceof RetryableError) {
      keyPool.markRateLimited(req.key!);
      req.log.warn(
        { key: req.key!.hash, retryCount: req.retryCount },
        `Re-enqueueing request due to retryable error during streaming response.`
      );
      req.retryCount++;
      await enqueue(req);
    } else {
      const { message, stack, lastEvent } = err;
      const eventText = JSON.stringify(lastEvent, null, 2) ?? "undefined"
      const errorEvent = makeCompletionSSE({
        format: req.inboundApi,
        title: "Proxy stream error",
        message: "An unexpected error occurred while streaming the response.",
        obj: { message, stack, lastEvent: eventText },
        reqId: req.id,
        model: req.body?.model,
      });
      res.write(errorEvent);
      res.write(`data: [DONE]\n\n`);
      res.end();
    }
    throw err;
  }
};
