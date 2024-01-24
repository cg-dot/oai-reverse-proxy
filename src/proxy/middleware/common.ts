import { Request, Response } from "express";
import httpProxy from "http-proxy";
import { ZodError } from "zod";
import { generateErrorMessage } from "zod-error";
import { makeCompletionSSE } from "../../shared/streaming";
import { assertNever } from "../../shared/utils";
import { QuotaExceededError } from "./request/preprocessors/apply-quota-limits";

const OPENAI_CHAT_COMPLETION_ENDPOINT = "/v1/chat/completions";
const OPENAI_TEXT_COMPLETION_ENDPOINT = "/v1/completions";
const OPENAI_EMBEDDINGS_ENDPOINT = "/v1/embeddings";
const OPENAI_IMAGE_COMPLETION_ENDPOINT = "/v1/images/generations";
const ANTHROPIC_COMPLETION_ENDPOINT = "/v1/complete";

export function isTextGenerationRequest(req: Request) {
  return (
    req.method === "POST" &&
    [
      OPENAI_CHAT_COMPLETION_ENDPOINT,
      OPENAI_TEXT_COMPLETION_ENDPOINT,
      ANTHROPIC_COMPLETION_ENDPOINT,
    ].some((endpoint) => req.path.startsWith(endpoint))
  );
}

export function isImageGenerationRequest(req: Request) {
  return (
    req.method === "POST" &&
    req.path.startsWith(OPENAI_IMAGE_COMPLETION_ENDPOINT)
  );
}

export function isEmbeddingsRequest(req: Request) {
  return (
    req.method === "POST" && req.path.startsWith(OPENAI_EMBEDDINGS_ENDPOINT)
  );
}

export function writeErrorResponse(
  req: Request,
  res: Response,
  statusCode: number,
  statusMessage: string,
  errorPayload: Record<string, any>
) {
  const msg =
    statusCode === 500
      ? `The proxy encountered an error while trying to process your prompt.`
      : `The proxy encountered an error while trying to send your prompt to the upstream service.`;

  // If we're mid-SSE stream, send a data event with the error payload and end
  // the stream. Otherwise just send a normal error response.
  if (
    res.headersSent ||
    String(res.getHeader("content-type")).startsWith("text/event-stream")
  ) {
    const event = makeCompletionSSE({
      format: req.inboundApi,
      title: `Proxy error (HTTP ${statusCode} ${statusMessage})`,
      message: `${msg} Further technical details are provided below.`,
      obj: errorPayload,
      reqId: req.id,
      model: req.body?.model,
    });
    res.write(event);
    res.write(`data: [DONE]\n\n`);
    res.end();
  } else {
    if (req.tokenizerInfo && typeof errorPayload.error === "object") {
      errorPayload.error.proxy_tokenizer = req.tokenizerInfo;
    }
    res.status(statusCode).json(errorPayload);
  }
}

export const handleProxyError: httpProxy.ErrorCallback = (err, req, res) => {
  req.log.error(err, `Error during http-proxy-middleware request`);
  classifyErrorAndSend(err, req as Request, res as Response);
};

export const classifyErrorAndSend = (
  err: Error,
  req: Request,
  res: Response
) => {
  try {
    const { statusCode, statusMessage, userMessage, ...errorDetails } =
      classifyError(err);
    writeErrorResponse(req, res, statusCode, statusMessage, {
      error: { message: userMessage, ...errorDetails },
    });
  } catch (error) {
    req.log.error(error, `Error writing error response headers, giving up.`);
  }
};

function classifyError(err: Error): {
  /** HTTP status code returned to the client. */
  statusCode: number;
  /** HTTP status message returned to the client. */
  statusMessage: string;
  /** Message displayed to the user. */
  userMessage: string;
  /** Short error type, e.g. "proxy_validation_error". */
  type: string;
} & Record<string, any> {
  const defaultError = {
    statusCode: 500,
    statusMessage: "Internal Server Error",
    userMessage: `Reverse proxy error: ${err.message}`,
    type: "proxy_internal_error",
    stack: err.stack,
  };

  switch (err.constructor.name) {
    case "ZodError":
      const userMessage = generateErrorMessage((err as ZodError).issues, {
        prefix: "Request validation failed. ",
        path: { enabled: true, label: null, type: "breadcrumbs" },
        code: { enabled: false },
        maxErrors: 3,
        transform: ({ issue, ...rest }) => {
          return `At '${rest.pathComponent}': ${issue.message}`;
        },
      });
      return {
        statusCode: 400,
        statusMessage: "Bad Request",
        userMessage,
        type: "proxy_validation_error",
      };
    case "ZoomerForbiddenError":
      // Mimics a ban notice from OpenAI, thrown when blockZoomerOrigins blocks
      // a request.
      return {
        statusCode: 403,
        statusMessage: "Forbidden",
        userMessage: `Your account has been disabled for violating our terms of service.`,
        type: "organization_account_disabled",
        code: "policy_violation",
      };
    case "ForbiddenError":
      return {
        statusCode: 403,
        statusMessage: "Forbidden",
        userMessage: `Request is not allowed. (${err.message})`,
        type: "proxy_forbidden",
      };
    case "QuotaExceededError":
      return {
        statusCode: 429,
        statusMessage: "Too Many Requests",
        userMessage: `You've exceeded your token quota for this model type.`,
        type: "proxy_quota_exceeded",
        info: (err as QuotaExceededError).quotaInfo,
      };
    case "Error":
      if ("code" in err) {
        switch (err.code) {
          case "ENOTFOUND":
            return {
              statusCode: 502,
              statusMessage: "Bad Gateway",
              userMessage: `Reverse proxy encountered a DNS error while trying to connect to the upstream service.`,
              type: "proxy_network_error",
              code: err.code,
            };
          case "ECONNREFUSED":
            return {
              statusCode: 502,
              statusMessage: "Bad Gateway",
              userMessage: `Reverse proxy couldn't connect to the upstream service.`,
              type: "proxy_network_error",
              code: err.code,
            };
          case "ECONNRESET":
            return {
              statusCode: 504,
              statusMessage: "Gateway Timeout",
              userMessage: `Reverse proxy timed out while waiting for the upstream service to respond.`,
              type: "proxy_network_error",
              code: err.code,
            };
        }
      }
      return defaultError;
    default:
      return defaultError;
  }
}

export function getCompletionFromBody(req: Request, body: Record<string, any>) {
  const format = req.outboundApi;
  switch (format) {
    case "openai":
    case "mistral-ai":
      // Can be null if the model wants to invoke tools rather than return a
      // completion.
      return body.choices[0].message.content || "";
    case "openai-text":
      return body.choices[0].text;
    case "anthropic":
      if (!body.completion) {
        req.log.error(
          { body: JSON.stringify(body) },
          "Received empty Anthropic completion"
        );
        return "";
      }
      return body.completion.trim();
    case "google-ai":
      if ("choices" in body) {
        return body.choices[0].message.content;
      }
      return body.candidates[0].content.parts[0].text;
    case "openai-image":
      return body.data?.map((item: any) => item.url).join("\n");
    default:
      assertNever(format);
  }
}

export function getModelFromBody(req: Request, body: Record<string, any>) {
  const format = req.outboundApi;
  switch (format) {
    case "openai":
    case "openai-text":
    case "mistral-ai":
      return body.model;
    case "openai-image":
      return req.body.model;
    case "anthropic":
      // Anthropic confirms the model in the response, but AWS Claude doesn't.
      return body.model || req.body.model;
    case "google-ai":
      // Google doesn't confirm the model in the response.
      return req.body.model;
    default:
      assertNever(format);
  }
}
