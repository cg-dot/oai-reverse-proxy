import { Request, Response } from "express";
import * as http from "http";
import { buildFakeSseMessage } from "../common";
import { RawResponseBodyHandler, decodeResponseBody } from ".";

type OpenAiChatCompletionResponse = {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: {
    message: { role: string; content: string };
    finish_reason: string | null;
    index: number;
  }[];
};

type AnthropicCompletionResponse = {
  completion: string;
  stop_reason: string;
  truncated: boolean;
  stop: any;
  model: string;
  log_id: string;
  exception: null;
};

/**
 * Consume the SSE stream and forward events to the client. Once the stream is
 * stream is closed, resolve with the full response body so that subsequent
 * middleware can work with it.
 *
 * Typically we would only need of the raw response handlers to execute, but
 * in the event a streamed request results in a non-200 response, we need to
 * fall back to the non-streaming response handler so that the error handler
 * can inspect the error response.
 *
 * Currently most frontends don't support Anthropic streaming, so users can opt
 * to send requests for Claude models via an endpoint that accepts OpenAI-
 * compatible requests and translates the received Anthropic SSE events into
 * OpenAI ones, essentially pretending to be an OpenAI streaming API.
 */
export const handleStreamedResponse: RawResponseBodyHandler = async (
  proxyRes,
  req,
  res
) => {
  // If these differ, the user is using the OpenAI-compatibile endpoint, so
  // we need to translate the SSE events into OpenAI completion events for their
  // frontend.
  if (!req.isStreaming) {
    const err = new Error(
      "handleStreamedResponse called for non-streaming request."
    );
    req.log.error({ stack: err.stack, api: req.inboundApi }, err.message);
    throw err;
  }

  const key = req.key!;
  if (proxyRes.statusCode !== 200) {
    // Ensure we use the non-streaming middleware stack since we won't be
    // getting any events.
    req.isStreaming = false;
    req.log.warn(
      { statusCode: proxyRes.statusCode, key: key.hash },
      `Streaming request returned error status code. Falling back to non-streaming response handler.`
    );
    return decodeResponseBody(proxyRes, req, res);
  }

  return new Promise((resolve, reject) => {
    req.log.info({ key: key.hash }, `Starting to proxy SSE stream.`);

    // Queued streaming requests will already have a connection open and headers
    // sent due to the heartbeat handler.  In that case we can just start
    // streaming the response without sending headers.
    if (!res.headersSent) {
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");
      res.setHeader("X-Accel-Buffering", "no");
      copyHeaders(proxyRes, res);
      res.flushHeaders();
    }

    const originalEvents: string[] = [];
    let partialMessage = "";
    let lastPosition = 0;

    type ProxyResHandler<T extends unknown> = (...args: T[]) => void;
    function withErrorHandling<T extends unknown>(fn: ProxyResHandler<T>) {
      return (...args: T[]) => {
        try {
          fn(...args);
        } catch (error) {
          proxyRes.emit("error", error);
        }
      };
    }

    proxyRes.on(
      "data",
      withErrorHandling((chunk: Buffer) => {
        // We may receive multiple (or partial) SSE messages in a single chunk,
        // so we need to buffer and emit seperate stream events for full
        // messages so we can parse/transform them properly.
        const str = chunk.toString();

        // Anthropic uses CRLF line endings (out-of-spec btw)
        const fullMessages = (partialMessage + str).split(/\r?\n\r?\n/);
        partialMessage = fullMessages.pop() || "";

        for (const message of fullMessages) {
          proxyRes.emit("full-sse-event", message);
        }
      })
    );

    proxyRes.on(
      "full-sse-event",
      withErrorHandling((data) => {
        originalEvents.push(data);
        const { event, position } = transformEvent({
          data,
          requestApi: req.inboundApi,
          responseApi: req.outboundApi,
          lastPosition,
        });
        lastPosition = position;
        res.write(event + "\n\n");
      })
    );

    proxyRes.on(
      "end",
      withErrorHandling(() => {
        let finalBody = convertEventsToFinalResponse(originalEvents, req);
        req.log.info({ key: key.hash }, `Finished proxying SSE stream.`);
        res.end();
        resolve(finalBody);
      })
    );

    proxyRes.on("error", (err) => {
      req.log.error({ error: err, key: key.hash }, `Mid-stream error.`);
      const fakeErrorEvent = buildFakeSseMessage(
        "mid-stream-error",
        err.message,
        req
      );
      res.write(`data: ${JSON.stringify(fakeErrorEvent)}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
      reject(err);
    });
  });
};

/**
 * Transforms SSE events from the given response API into events compatible with
 * the API requested by the client.
 */
function transformEvent({
  data,
  requestApi,
  responseApi,
  lastPosition,
}: {
  data: string;
  requestApi: string;
  responseApi: string;
  lastPosition: number;
}) {
  if (requestApi === responseApi) {
    return { position: -1, event: data };
  }

  if (requestApi === "anthropic" && responseApi === "openai") {
    throw new Error(`Anthropic -> OpenAI streaming not implemented.`);
  }

  // Anthropic sends the full completion so far with each event whereas OpenAI
  // only sends the delta. To make the SSE events compatible, we remove
  // everything before `lastPosition` from the completion.
  if (!data.startsWith("data:")) {
    return { position: lastPosition, event: data };
  }

  if (data.startsWith("data: [DONE]")) {
    return { position: lastPosition, event: data };
  }

  const event = JSON.parse(data.slice("data: ".length));
  const newEvent = {
    id: "ant-" + event.log_id,
    object: "chat.completion.chunk",
    created: Date.now(),
    model: event.model,
    choices: [
      {
        index: 0,
        delta: { content: event.completion?.slice(lastPosition) },
        finish_reason: event.stop_reason,
      },
    ],
  };
  return {
    position: event.completion.length,
    event: `data: ${JSON.stringify(newEvent)}`,
  };
}

/** Copy headers, excluding ones we're already setting for the SSE response. */
function copyHeaders(proxyRes: http.IncomingMessage, res: Response) {
  const toOmit = [
    "content-length",
    "content-encoding",
    "transfer-encoding",
    "content-type",
    "connection",
    "cache-control",
  ];
  for (const [key, value] of Object.entries(proxyRes.headers)) {
    if (!toOmit.includes(key) && value) {
      res.setHeader(key, value);
    }
  }
}

/**
 * Converts the list of incremental SSE events into an object that resembles a
 * full, non-streamed response from the API so that subsequent middleware can
 * operate on it as if it were a normal response.
 * Events are expected to be in the format they were received from the API.
 */
function convertEventsToFinalResponse(events: string[], req: Request) {
  if (req.outboundApi === "openai") {
    let response: OpenAiChatCompletionResponse = {
      id: "",
      object: "",
      created: 0,
      model: "",
      choices: [],
    };
    response = events.reduce((acc, event, i) => {
      if (!event.startsWith("data: ")) {
        return acc;
      }

      if (event === "data: [DONE]") {
        return acc;
      }

      const data = JSON.parse(event.slice("data: ".length));
      if (i === 0) {
        return {
          id: data.id,
          object: data.object,
          created: data.created,
          model: data.model,
          choices: [
            {
              message: { role: data.choices[0].delta.role, content: "" },
              index: 0,
              finish_reason: null,
            },
          ],
        };
      }

      if (data.choices[0].delta.content) {
        acc.choices[0].message.content += data.choices[0].delta.content;
      }
      acc.choices[0].finish_reason = data.choices[0].finish_reason;
      return acc;
    }, response);
    return response;
  }
  if (req.outboundApi === "anthropic") {
    /*
     * Full complete responses from Anthropic are conveniently just the same as
     * the final SSE event before the "DONE" event, so we can reuse that
     */
    const lastEvent = events[events.length - 2].toString();
    const data = JSON.parse(lastEvent.slice(lastEvent.indexOf("data: ") + "data: ".length));
    const response: AnthropicCompletionResponse = {
      ...data,
      log_id: req.id,
    };
    return response;
  }
  throw new Error("If you get this, something is fucked");
}
