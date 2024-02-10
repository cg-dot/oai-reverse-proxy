import pino from "pino";
import { Duplex, Readable } from "stream";
import { EventStreamMarshaller } from "@smithy/eventstream-serde-node";
import { fromUtf8, toUtf8 } from "@smithy/util-utf8";
import { Message } from "@smithy/eventstream-codec";

/**
 * Decodes a Readable stream, such as a proxied HTTP response, into a stream of
 * Message objects using the AWS SDK's EventStreamMarshaller. Error events in
 * the amazon eventstream protocol are decoded as Message objects and will not
 * emit an error event on the decoder stream.
 */
export function getAwsEventStreamDecoder(params: {
  input: Readable;
  logger: pino.Logger;
}): Duplex {
  const { input, logger } = params;
  const config = { utf8Encoder: toUtf8, utf8Decoder: fromUtf8 };
  const eventStream = new EventStreamMarshaller(config).deserialize(
    input,
    async (input: Record<string, Message>) => {
      const eventType = Object.keys(input)[0];
      let result;
      if (eventType === "chunk") {
        result = input[eventType];
      } else {
        // AWS unmarshaller treats non-chunk (errors and exceptions) oddly.
        result = { [eventType]: input[eventType] } as any;
      }
      return result;
    }
  );
  return new AWSEventStreamDecoder(eventStream, { logger });
}

class AWSEventStreamDecoder extends Duplex {
  private readonly asyncIterable: AsyncIterable<Message>;
  private iterator: AsyncIterator<Message>;
  private reading: boolean;
  private logger: pino.Logger;

  constructor(
    asyncIterable: AsyncIterable<Message>,
    options: { logger: pino.Logger }
  ) {
    super({ ...options, objectMode: true });
    this.asyncIterable = asyncIterable;
    this.iterator = this.asyncIterable[Symbol.asyncIterator]();
    this.reading = false;
    this.logger = options.logger.child({ module: "aws-eventstream-decoder" });
  }

  async _read(_size: number) {
    if (this.reading) return;
    this.reading = true;

    try {
      while (true) {
        const { value, done } = await this.iterator.next();
        if (done) {
          this.push(null);
          break;
        }
        if (!this.push(value)) break;
      }
    } catch (err) {
      // AWS SDK's EventStreamMarshaller emits errors in the stream itself as
      // whatever our deserializer returns, which will not be Error objects
      // because we want to pass the Message to the next stream for processing.
      // Any actual Error thrown here is some failure during deserialization.
      const isAwsError = !(err instanceof Error);

      if (isAwsError) {
        this.logger.warn({ err: err.headers }, "Received AWS error event");
        this.push(err);
        this.push(null);
      } else {
        this.logger.error(err, "Error during AWS stream deserialization");
        this.destroy(err);
      }
    } finally {
      this.reading = false;
    }
  }

  _write(_chunk: any, _encoding: string, callback: () => void) {
    callback();
  }

  _final(callback: () => void) {
    callback();
  }
}
