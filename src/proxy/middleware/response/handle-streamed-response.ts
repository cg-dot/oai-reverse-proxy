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
 * `handleStreamedResponse` consumes and transforms a streamed response from the
 * upstream service, forwarding events to the client in their requested format.
 * After the entire stream has been consumed, it resolves with the full response
 * body so that subsequent middleware in the chain can process it as if it were
 * a non-streaming response.
 *
 * In the event of an error, the request's streaming flag is unset and the non-
 * streaming response handler is called instead.
 *
 * If the error is retryable, that handler will re-enqueue the request and also
 * reset the streaming flag. Unfortunately the streaming flag is set and unset
 * in multiple places, so it's hard to keep track of.
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

  // Typically, streaming will have already been initialized by the request
  // queue to send heartbeat pings.
  if (!res.headersSent) {
    copySseResponseHeaders(proxyRes, res);
    initializeSseStream(res);
  }

  const prefersNativeEvents = req.inboundApi === req.outboundApi;
  const contentType = proxyRes.headers["content-type"];

  // Adapter turns some arbitrary stream (binary, JSON, etc.) into SSE events.
  const adapter = new SSEStreamAdapter({ contentType, api: req.outboundApi });
  // Aggregator compiles all events into a single response object.
  const aggregator = new EventAggregator({ format: req.outboundApi });
  // Transformer converts events to the user's requested format.
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
