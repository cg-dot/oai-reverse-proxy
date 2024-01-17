import { Transform, TransformOptions } from "stream";

import { StringDecoder } from "string_decoder";
// @ts-ignore
import { Parser } from "lifion-aws-event-stream";
import { logger } from "../../../../logger";
import { RetryableError } from "../index";
import { APIFormat } from "../../../../shared/key-management";
import StreamArray from "stream-json/streamers/StreamArray";
import { makeCompletionSSE } from "../../../../shared/streaming";

const log = logger.child({ module: "sse-stream-adapter" });

type SSEStreamAdapterOptions = TransformOptions & {
  contentType?: string;
  api: APIFormat;
};
type AwsEventStreamMessage = {
  headers: {
    ":message-type": "event" | "exception";
    ":exception-type"?: string;
  };
  payload: { message?: string /** base64 encoded */; bytes?: string };
};

/**
 * Receives either text chunks or AWS binary event stream chunks and emits
 * full SSE events.
 */
export class SSEStreamAdapter extends Transform {
  private readonly isAwsStream;
  private readonly isGoogleStream;
  private awsParser = new Parser();
  private jsonParser = StreamArray.withParser();
  private partialMessage = "";
  private decoder = new StringDecoder("utf8");

  constructor(options?: SSEStreamAdapterOptions) {
    super(options);
    this.isAwsStream =
      options?.contentType === "application/vnd.amazon.eventstream";
    this.isGoogleStream = options?.api === "google-ai";

    this.awsParser.on("data", (data: AwsEventStreamMessage) => {
      const message = this.processAwsEvent(data);
      if (message) {
        this.push(Buffer.from(message + "\n\n"), "utf8");
      }
    });

    this.jsonParser.on("data", (data: { value: any }) => {
      const message = this.processGoogleValue(data.value);
      if (message) {
        this.push(Buffer.from(message + "\n\n"), "utf8");
      }
    });
  }

  protected processAwsEvent(event: AwsEventStreamMessage): string | null {
    const { payload, headers } = event;
    if (headers[":message-type"] === "exception" || !payload.bytes) {
      const eventStr = JSON.stringify(event);
      // Under high load, AWS can rugpull us by returning a 200 and starting the
      // stream but then immediately sending a rate limit error as the first
      // event. My guess is some race condition in their rate limiting check
      // that occurs if two requests arrive at the same time when only one
      // concurrency slot is available.
      if (headers[":exception-type"] === "throttlingException") {
        log.warn(
          { event: eventStr },
          "AWS request throttled after streaming has already started; retrying"
        );
        throw new RetryableError("AWS request throttled mid-stream");
      } else {
        log.error({ event: eventStr }, "Received bad AWS stream event");
        return makeCompletionSSE({
          format: "anthropic",
          title: "Proxy stream error",
          message:
            "The proxy received malformed or unexpected data from AWS while streaming.",
          obj: event,
          reqId: "proxy-sse-adapter-message",
          model: "",
        });
      }
    } else {
      const { bytes } = payload;
      return [
        "event: completion",
        `data: ${Buffer.from(bytes, "base64").toString("utf8")}`,
      ].join("\n");
    }
  }

  /** Processes an incoming array element from the Google AI JSON stream. */
  protected processGoogleValue(value: any): string | null {
    try {
      const candidates = value.candidates ?? [{}];
      const hasParts = candidates[0].content?.parts?.length > 0;
      if (hasParts) {
        return `data: ${JSON.stringify(value)}`;
      } else {
        log.error({ event: value }, "Received bad Google AI event");
        return `data: ${makeCompletionSSE({
          format: "google-ai",
          title: "Proxy stream error",
          message:
            "The proxy received malformed or unexpected data from Google AI while streaming.",
          obj: value,
          reqId: "proxy-sse-adapter-message",
          model: "",
        })}`;
      }
    } catch (error) {
      error.lastEvent = value;
      this.emit("error", error);
      return null;
    }
  }

  _transform(chunk: Buffer, _encoding: BufferEncoding, callback: Function) {
    try {
      if (this.isAwsStream) {
        this.awsParser.write(chunk);
      } else if (this.isGoogleStream) {
        this.jsonParser.write(chunk);
      } else {
        // We may receive multiple (or partial) SSE messages in a single chunk,
        // so we need to buffer and emit separate stream events for full
        // messages so we can parse/transform them properly.
        const str = this.decoder.write(chunk);

        const fullMessages = (this.partialMessage + str).split(
          /\r\r|\n\n|\r\n\r\n/
        );
        this.partialMessage = fullMessages.pop() || "";

        for (const message of fullMessages) {
          // Mixing line endings will break some clients and our request queue
          // will have already sent \n for heartbeats, so we need to normalize
          // to \n.
          this.push(message.replace(/\r\n?/g, "\n") + "\n\n");
        }
      }
      callback();
    } catch (error) {
      error.lastEvent = chunk?.toString();
      this.emit("error", error);
      callback(error);
    }
  }
}
