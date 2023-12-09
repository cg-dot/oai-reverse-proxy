import { Transform, TransformOptions } from "stream";
import { StringDecoder } from "string_decoder";
// @ts-ignore
import { Parser } from "lifion-aws-event-stream";
import { logger } from "../../../../logger";
import { RetryableError } from "../index";

const log = logger.child({ module: "sse-stream-adapter" });

type SSEStreamAdapterOptions = TransformOptions & { contentType?: string };
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
  private parser = new Parser();
  private partialMessage = "";
  private decoder = new StringDecoder("utf8");

  constructor(options?: SSEStreamAdapterOptions) {
    super(options);
    this.isAwsStream =
      options?.contentType === "application/vnd.amazon.eventstream";

    this.parser.on("data", (data: AwsEventStreamMessage) => {
      const message = this.processAwsEvent(data);
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
        log.error(
          { event: eventStr },
          "Received unexpected AWS event stream message"
        );
        return getFakeErrorCompletion("proxy AWS error", eventStr);
      }
    } else {
      const { bytes } = payload;
      // technically this is a transformation but we don't really distinguish
      // between aws claude and anthropic claude at the APIFormat level, so
      // these will short circuit the message transformer
      return [
        "event: completion",
        `data: ${Buffer.from(bytes, "base64").toString("utf8")}`,
      ].join("\n");
    }
  }

  _transform(chunk: Buffer, _encoding: BufferEncoding, callback: Function) {
    try {
      if (this.isAwsStream) {
        this.parser.write(chunk);
      } else {
        // We may receive multiple (or partial) SSE messages in a single chunk,
        // so we need to buffer and emit separate stream events for full
        // messages so we can parse/transform them properly.
        const str = this.decoder.write(chunk);

        const fullMessages = (this.partialMessage + str).split(/\r\r|\n\n|\r\n\r\n/);
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
      this.emit("error", error);
      callback(error);
    }
  }
}

function getFakeErrorCompletion(type: string, message: string) {
  const content = `\`\`\`\n[${type}: ${message}]\n\`\`\`\n`;
  const fakeEvent = JSON.stringify({
    log_id: "aws-proxy-sse-message",
    stop_reason: type,
    completion:
      "\nProxy encountered an error during streaming response.\n" + content,
    truncated: false,
    stop: null,
    model: "",
  });
  return ["event: completion", `data: ${fakeEvent}\n\n`].join("\n");
}
