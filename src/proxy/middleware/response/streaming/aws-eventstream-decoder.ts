import { Transform, TransformOptions } from "stream";
import {
  EventStreamCodec,
  Message,
  MessageDecoderStream,
} from "@smithy/eventstream-codec";
import { fromUtf8, toUtf8 } from "@smithy/util-utf8";
import { logger } from "../../../../logger";

const log = logger.child({ module: "aws-eventstream-decoder" });

/**
 * Consumes an HTTP response stream and transforms it into a decoded stream of
 * AWS vnd.amazon.eventstream messages.
 *
 * The AWS library uses async iterators, so this class needs to act as a bridge
 * between the async generator and the Node stream API for downstream consumers.
 */
export class AWSEventStreamDecoder extends Transform {
  private readonly decoder: EventStreamCodec;
  private messageStream: MessageDecoderStream | null = null;
  private queue: Uint8Array[] = [];
  private resolveChunk: ((value: Uint8Array | null) => void) | null = null;

  constructor(options?: TransformOptions) {
    super({ ...options, objectMode: true });
    this.decoder = new EventStreamCodec(toUtf8, fromUtf8);
    this.setupStream();
  }

  protected enqueueChunk(chunk: Uint8Array) {
    if (this.resolveChunk) {
      this.resolveChunk(chunk);
      this.resolveChunk = null;
    } else {
      this.queue.push(chunk);
    }
  }

  protected dequeueChunk(): Promise<Uint8Array | null> {
    if (this.queue.length > 0) {
      return Promise.resolve(this.queue.shift()!);
    }
    return new Promise((resolve) => (this.resolveChunk = resolve));
  }

  protected setupStream() {
    const that = this;

    // This generator wraps the response stream (via the chunk queue) in an
    // async iterable that can be consumed by the Amazon EventStream library.
    const inputGenerator = (async function* () {
      while (true) {
        const chunk = await that.dequeueChunk();
        if (chunk === null) break;
        yield chunk;
      }
      log.debug("Input stream generator finished");
    });

    // MessageDecoderStream is an async iterator that consumes chunks from
    // inputGenerator and yields fully decoded individual messages.
    this.messageStream = new MessageDecoderStream({
      decoder: this.decoder,
      inputStream: inputGenerator(),
    });

    // Start the generator and push messages downstream as they are decoded.
    let lastMessage: Message | null = null;
    (async function () {
      try {
        log.debug("Starting generator");
        for await (const message of that.messageStream!) {
          lastMessage = message;
          that.push(message);
        }
        that.push(null);
      } catch (err) {
        log.error({ err, lastMessage }, "Error decoding eventstream message");
        that.emit("error", err);
      }
    })();
  }

  _transform(chunk: Buffer, _encoding: string, callback: () => void) {
    this.enqueueChunk(chunk);
    callback();
  }

  _flush(callback: () => void) {
    log.debug("Received end of stream; stopping generator");
    if (this.resolveChunk) {
      this.resolveChunk(null);
    }
    callback();
  }
}
