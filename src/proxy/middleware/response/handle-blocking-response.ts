import util from "util";
import zlib from "zlib";
import { sendProxyError } from "../common";
import type { RawResponseBodyHandler } from "./index";

const DECODER_MAP = {
  gzip: util.promisify(zlib.gunzip),
  deflate: util.promisify(zlib.inflate),
  br: util.promisify(zlib.brotliDecompress),
};

const isSupportedContentEncoding = (
  contentEncoding: string
): contentEncoding is keyof typeof DECODER_MAP => {
  return contentEncoding in DECODER_MAP;
};

/**
 * Handles the response from the upstream service and decodes the body if
 * necessary. If the response is JSON, it will be parsed and returned as an
 * object. Otherwise, it will be returned as a string. Does not handle streaming
 * responses.
 * @throws {Error} Unsupported content-encoding or invalid application/json body
 */
export const handleBlockingResponse: RawResponseBodyHandler = async (
  proxyRes,
  req,
  res
) => {
  if (req.isStreaming) {
    const err = new Error(
      "handleBlockingResponse called for a streaming request."
    );
    req.log.error({ stack: err.stack, api: req.inboundApi }, err.message);
    throw err;
  }

  return new Promise<string>((resolve, reject) => {
    let chunks: Buffer[] = [];
    proxyRes.on("data", (chunk) => chunks.push(chunk));
    proxyRes.on("end", async () => {
      let body = Buffer.concat(chunks);

      const contentEncoding = proxyRes.headers["content-encoding"];
      if (contentEncoding) {
        if (isSupportedContentEncoding(contentEncoding)) {
          const decoder = DECODER_MAP[contentEncoding];
          // @ts-ignore - started failing after upgrading TypeScript, don't care
          // as it was never a problem.
          body = await decoder(body);
        } else {
          const error = `Proxy received response with unsupported content-encoding: ${contentEncoding}`;
          req.log.warn({ contentEncoding, key: req.key?.hash }, error);
          sendProxyError(req, res, 500, "Internal Server Error", {
            error,
            contentEncoding,
          });
          return reject(error);
        }
      }

      try {
        if (proxyRes.headers["content-type"]?.includes("application/json")) {
          const json = JSON.parse(body.toString());
          return resolve(json);
        }
        return resolve(body.toString());
      } catch (e) {
        const msg = `Proxy received response with invalid JSON: ${e.message}`;
        req.log.warn({ error: e.stack, key: req.key?.hash }, msg);
        sendProxyError(req, res, 500, "Internal Server Error", { error: msg });
        return reject(msg);
      }
    });
  });
};
