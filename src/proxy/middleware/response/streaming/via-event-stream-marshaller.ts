import { Duplex, Readable } from "stream";
import { EventStreamMarshaller } from "@smithy/eventstream-serde-node";
import { fromUtf8, toUtf8 } from "@smithy/util-utf8";
import { Message } from "@smithy/eventstream-codec";

/**
 * Decodes a Readable stream, such as a proxied HTTP response, into a stream of
 * Message objects using the AWS SDK's EventStreamMarshaller.
 * @param input
 */
export function viaEventStreamMarshaller(input: Readable): Duplex {
  const config = { utf8Encoder: toUtf8, utf8Decoder: fromUtf8 };
  const eventStream = new EventStreamMarshaller(config).deserialize(
    input,
    // deserializer is always an object with one key. we just extract the value
    // and pipe it to SSEStreamAdapter for it to turn it into an SSE stream
    async (input: Record<string, Message>) => Object.values(input)[0]
  );
  return new StreamFromIterable(eventStream);
}

// In theory, Duplex.from(eventStream) would have rendered this wrapper
// unnecessary, but I was not able to get it to work for a number of reasons and
// needed more control over the stream's lifecycle.

class StreamFromIterable extends Duplex {
  private readonly asyncIterable: AsyncIterable<Message>;
  private iterator: AsyncIterator<Message>;
  private reading: boolean;

  constructor(asyncIterable: AsyncIterable<Message>, options = {}) {
    super({ ...options, objectMode: true });
    this.asyncIterable = asyncIterable;
    this.iterator = this.asyncIterable[Symbol.asyncIterator]();
    this.reading = false;
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
      this.destroy(err);
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
