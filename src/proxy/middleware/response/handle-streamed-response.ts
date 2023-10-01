import { Request, Response } from "express";
import * as http from "http";
import { buildFakeSseMessage } from "../common";
import { RawResponseBodyHandler, decodeResponseBody } from ".";
import { assertNever } from "../../../shared/utils";
import { ServerSentEventStreamAdapter } from "./sse-stream-adapter";

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

type OpenAiTextCompletionResponse = {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: {
    text: string;
    finish_reason: string | null;
    index: number;
    logprobs: null;
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

  req.log.debug(
    { headers: proxyRes.headers, key: key.hash },
    `Received SSE headers.`
  );

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

    const adapter = new ServerSentEventStreamAdapter({
      isAwsStream:
        proxyRes.headers["content-type"] ===
        "application/vnd.amazon.eventstream",
    });

    const events: string[] = [];
    let lastPosition = 0;
    let eventCount = 0;

    proxyRes.pipe(adapter);

    adapter.on("data", (chunk: any) => {
      try {
        const { event, position } = transformEvent({
          data: chunk.toString(),
          requestApi: req.inboundApi,
          responseApi: req.outboundApi,
          lastPosition,
          index: eventCount++,
        });
        events.push(event);
        lastPosition = position;
        res.write(event + "\n\n");
      } catch (err) {
        adapter.emit("error", err);
      }
    });

    adapter.on("end", () => {
      try {
        req.log.info({ key: key.hash }, `Finished proxying SSE stream.`);
        const finalBody = convertEventsToFinalResponse(events, req);
        res.end();
        resolve(finalBody);
      } catch (err) {
        adapter.emit("error", err);
      }
    });

    adapter.on("error", (err) => {
      req.log.error({ error: err, key: key.hash }, `Mid-stream error.`);
      const errorEvent = buildFakeSseMessage("stream-error", err.message, req);
      res.write(`data: ${JSON.stringify(errorEvent)}\n\ndata: [DONE]\n\n`);
      res.end();
      reject(err);
    });
  });
};

type SSETransformationArgs = {
  data: string;
  requestApi: string;
  responseApi: string;
  lastPosition: number;
  index: number;
};

/**
 * Transforms SSE events from the given response API into events compatible with
 * the API requested by the client.
 */
function transformEvent(params: SSETransformationArgs) {
  const { data, requestApi, responseApi } = params;
  if (requestApi === responseApi) {
    return { position: -1, event: data };
  }

  const trans = `${requestApi}->${responseApi}`;
  switch (trans) {
    case "openai->openai-text":
      return transformOpenAITextEventToOpenAIChat(params);
    case "openai->anthropic":
      // TODO: handle new anthropic streaming format
      return transformV1AnthropicEventToOpenAI(params);
    default:
      throw new Error(`Unsupported streaming API transformation. ${trans}`);
  }
}

function transformOpenAITextEventToOpenAIChat(params: SSETransformationArgs) {
  const { data, index } = params;

  if (!data.startsWith("data:")) return { position: -1, event: data };
  if (data.startsWith("data: [DONE]")) return { position: -1, event: data };

  const event = JSON.parse(data.slice("data: ".length));

  // The very first event must be a role assignment with no content.

  const createEvent = () => ({
    id: event.id,
    object: "chat.completion.chunk",
    created: event.created,
    model: event.model,
    choices: [
      {
        message: { role: "", content: "" } as {
          role?: string;
          content: string;
        },
        index: 0,
        finish_reason: null,
      },
    ],
  });

  let buffer = "";

  if (index === 0) {
    const initialEvent = createEvent();
    initialEvent.choices[0].message.role = "assistant";
    buffer = `data: ${JSON.stringify(initialEvent)}\n\n`;
  }

  const newEvent = {
    ...event,
    choices: [
      {
        ...event.choices[0],
        delta: { content: event.choices[0].text },
        text: undefined,
      },
    ],
  };

  buffer += `data: ${JSON.stringify(newEvent)}`;

  return { position: -1, event: buffer };
}

function transformV1AnthropicEventToOpenAI(params: SSETransformationArgs) {
  const { data, lastPosition } = params;
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
  switch (req.outboundApi) {
    case "openai": {
      let merged: OpenAiChatCompletionResponse = {
        id: "",
        object: "",
        created: 0,
        model: "",
        choices: [],
      };
      merged = events.reduce((acc, event, i) => {
        if (!event.startsWith("data: ")) return acc;
        if (event === "data: [DONE]") return acc;

        const data = JSON.parse(event.slice("data: ".length));

        // The first chat chunk only contains the role assignment and metadata
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
      }, merged);
      return merged;
    }
    case "openai-text": {
      let merged: OpenAiTextCompletionResponse = {
        id: "",
        object: "",
        created: 0,
        model: "",
        choices: [],
        // TODO: merge logprobs
      };
      merged = events.reduce((acc, event) => {
        if (!event.startsWith("data: ")) return acc;
        if (event === "data: [DONE]") return acc;

        const data = JSON.parse(event.slice("data: ".length));

        return {
          id: data.id,
          object: data.object,
          created: data.created,
          model: data.model,
          choices: [
            {
              text: acc.choices[0]?.text + data.choices[0].text,
              index: 0,
              finish_reason: data.choices[0].finish_reason,
              logprobs: null,
            },
          ],
        };
      }, merged);
      return merged;
    }
    case "anthropic": {
      if (req.headers["anthropic-version"] === "2023-01-01") {
        return convertAnthropicV1(events, req);
      }

      let merged: AnthropicCompletionResponse = {
        completion: "",
        stop_reason: "",
        truncated: false,
        stop: null,
        model: req.body.model,
        log_id: "",
        exception: null,
      }

      merged = events.reduce((acc, event) => {
        if (!event.startsWith("data: ")) return acc;
        if (event === "data: [DONE]") return acc;

        const data = JSON.parse(event.slice("data: ".length));

        return {
          completion: acc.completion + data.completion,
          stop_reason: data.stop_reason,
          truncated: data.truncated,
          stop: data.stop,
          log_id: data.log_id,
          exception: data.exception,
          model: acc.model,
        };
      }, merged);
      return merged;
    }
    case "google-palm": {
      throw new Error("PaLM streaming not yet supported.");
    }
    default:
      assertNever(req.outboundApi);
  }
}

/** Older Anthropic streaming format which sent full completion each time. */
function convertAnthropicV1(
  events: string[],
  req: Request
) {
  const lastEvent = events[events.length - 2].toString();
  const data = JSON.parse(
    lastEvent.slice(lastEvent.indexOf("data: ") + "data: ".length)
  );
  const final: AnthropicCompletionResponse = { ...data, log_id: req.id };
  return final;
}
