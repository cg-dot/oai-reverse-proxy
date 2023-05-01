import { Response } from "express";
import * as http from "http";
import { RawResponseBodyHandler, decodeResponseBody } from ".";

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
  if (!req.isStreaming) {
    req.log.error(
      { api: req.api, key: req.key?.hash },
      `handleEventSource called for non-streaming request, which isn't valid.`
    );
    throw new Error("handleEventSource called for non-streaming request.");
  }

  if (proxyRes.statusCode !== 200) {
    // Ensure we use the non-streaming middleware stack since we won't be
    // getting any events.
    req.isStreaming = false;
    req.log.warn(
      `Streaming request to ${req.api} returned ${proxyRes.statusCode} status code. Falling back to non-streaming response handler.`
    );
    return decodeResponseBody(proxyRes, req, res);
  }

  return new Promise((resolve, reject) => {
    req.log.info(
      { api: req.api, key: req.key?.hash },
      `Starting to proxy SSE stream.`
    );
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    copyHeaders(proxyRes, res);

    const chunks: Buffer[] = [];
    proxyRes.on("data", (chunk) => {
      chunks.push(chunk);
      res.write(chunk);
    });

    proxyRes.on("end", () => {
      const finalBody = convertEventsToOpenAiResponse(chunks);
      req.log.info(
        { api: req.api, key: req.key?.hash },
        `Finished proxying SSE stream.`
      );
      res.end();
      resolve(finalBody);
    });
    proxyRes.on("error", (err) => {
      req.log.error(
        { error: err, api: req.api, key: req.key?.hash },
        `Error while streaming response.`
      );
      res.end();
      reject(err);
    });
  });
};

/** Copy headers, excluding ones we're already setting for the SSE response. */
const copyHeaders = (proxyRes: http.IncomingMessage, res: Response) => {
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
};

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

/** Converts the event stream chunks into a single completion response. */
const convertEventsToOpenAiResponse = (chunks: Buffer[]) => {
  let response: OpenAiChatCompletionResponse = {
    id: "",
    object: "",
    created: 0,
    model: "",
    choices: [],
  };
  const events = Buffer.concat(chunks)
    .toString()
    .trim()
    .split("\n\n")
    .map((line) => line.trim());

  response = events.reduce((acc, chunk, i) => {
    if (!chunk.startsWith("data: ")) {
      return acc;
    }

    if (chunk === "data: [DONE]") {
      return acc;
    }

    const data = JSON.parse(chunk.slice("data: ".length));
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
};
