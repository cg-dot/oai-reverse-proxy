import { Transform, TransformOptions } from "stream";
import { Message } from "@smithy/eventstream-codec";
import StreamArray from "stream-json/streamers/StreamArray";
import { StringDecoder } from "string_decoder";
import { logger } from "../../../../logger";
import { APIFormat } from "../../../../shared/key-management";
import { makeCompletionSSE } from "../../../../shared/streaming";
import { RetryableError } from "../index";
import { AWSEventStreamDecoder } from "./aws-eventstream-decoder";

const log = logger.child({ module: "sse-stream-adapter" });

type SSEStreamAdapterOptions = TransformOptions & {
  contentType?: string;
  api: APIFormat;
};

/**
 * Receives either text chunks or AWS vnd.amazon.eventstream messages and emits
 * full SSE-compliant messages.
 */
export class SSEStreamAdapter extends Transform {
  private readonly isAwsStream;
  private readonly isGoogleStream;
  private awsDecoder = new AWSEventStreamDecoder();
  private jsonParser = StreamArray.withParser();
  private partialMessage = "";
  private decoder = new StringDecoder("utf8");
  private textDecoder = new TextDecoder("utf8");

  constructor(options?: SSEStreamAdapterOptions) {
    super(options);
    this.isAwsStream =
      options?.contentType === "application/vnd.amazon.eventstream";
    this.isGoogleStream = options?.api === "google-ai";

    this.awsDecoder.on("data", (data: Message) => {
      try {
        const message = this.processAwsEvent(data);
        if (message) {
          this.push(Buffer.from(message + "\n\n"), "utf8");
        }
      } catch (error) {
        this.emit("error", error);
      }
    });

    this.jsonParser.on("data", (data: { value: any }) => {
      const message = this.processGoogleValue(data.value);
      if (message) {
        this.push(Buffer.from(message + "\n\n"), "utf8");
      }
    });
  }

  protected processAwsEvent(message: Message): string | null {
    // Per amazon, headers and body are always present. headers is an object,
    // body is a Uint8Array, potentially zero-length.
    const { headers, body } = message;
    const eventType = headers[":event-type"]?.value;
    const messageType = headers[":message-type"]?.value;
    const contentType = headers[":content-type"]?.value;
    const exceptionType = headers[":exception-type"]?.value;
    const errorCode = headers[":error-code"]?.value;
    const bodyStr = this.textDecoder.decode(body);

    switch (messageType) {
      case "event":
        if (contentType === "application/json" && eventType === "chunk") {
          const { bytes } = JSON.parse(bodyStr);
          const event = Buffer.from(bytes, "base64").toString("utf8");
          return ["event: completion", `data: ${event}`].join(`\n`);
        }
      // Intentional fallthrough, non-JSON events will be something very weird
      // noinspection FallThroughInSwitchStatementJS
      case "exception":
      case "error":
        const type = exceptionType || errorCode || "UnknownError";
        switch (type) {
          case "ThrottlingException":
            log.warn(
              { message, type },
              "AWS request throttled after streaming has already started; retrying"
            );
            throw new RetryableError("AWS request throttled mid-stream");
          default:
            log.error({ message, type }, "Received bad AWS stream event");
            return makeCompletionSSE({
              format: "anthropic",
              title: "Proxy stream error",
              message:
                "The proxy received an unrecognized error from AWS while streaming.",
              obj: message,
              reqId: "proxy-sse-adapter-message",
              model: "",
            });
        }
      default:
        // Amazon says this can't ever happen...
        log.error({ message }, "Received very bad AWS stream event");
        return null;
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
        this.awsDecoder.write(chunk);
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
