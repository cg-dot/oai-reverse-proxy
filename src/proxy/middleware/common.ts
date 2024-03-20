import { Request, Response } from "express";
import http from "http";
import httpProxy from "http-proxy";
import { ZodError } from "zod";
import { generateErrorMessage } from "zod-error";
import { HttpError } from "../../shared/errors";
import { assertNever } from "../../shared/utils";
import { QuotaExceededError } from "./request/preprocessors/apply-quota-limits";
import { sendErrorToClient } from "./response/error-generator";

const OPENAI_CHAT_COMPLETION_ENDPOINT = "/v1/chat/completions";
const OPENAI_TEXT_COMPLETION_ENDPOINT = "/v1/completions";
const OPENAI_EMBEDDINGS_ENDPOINT = "/v1/embeddings";
const OPENAI_IMAGE_COMPLETION_ENDPOINT = "/v1/images/generations";
const ANTHROPIC_COMPLETION_ENDPOINT = "/v1/complete";
const ANTHROPIC_MESSAGES_ENDPOINT = "/v1/messages";
const ANTHROPIC_SONNET_COMPAT_ENDPOINT = "/v1/sonnet";
const ANTHROPIC_OPUS_COMPAT_ENDPOINT = "/v1/opus";

export function isTextGenerationRequest(req: Request) {
  return (
    req.method === "POST" &&
    [
      OPENAI_CHAT_COMPLETION_ENDPOINT,
      OPENAI_TEXT_COMPLETION_ENDPOINT,
      ANTHROPIC_COMPLETION_ENDPOINT,
      ANTHROPIC_MESSAGES_ENDPOINT,
      ANTHROPIC_SONNET_COMPAT_ENDPOINT,
      ANTHROPIC_OPUS_COMPAT_ENDPOINT,
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

export function sendProxyError(
  req: Request,
  res: Response,
  statusCode: number,
  statusMessage: string,
  errorPayload: Record<string, any>
) {
  const msg =
    statusCode === 500
      ? `The proxy encountered an error while trying to process your prompt.`
      : `The proxy encountered an error while trying to send your prompt to the API.`;

  sendErrorToClient({
    options: {
      format: req.inboundApi,
      title: `Proxy error (HTTP ${statusCode} ${statusMessage})`,
      message: `${msg} Further details are provided below.`,
      obj: errorPayload,
      reqId: req.id,
      model: req.body?.model,
    },
    req,
    res,
  });
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
    sendProxyError(req, res, statusCode, statusMessage, {
      error: { message: userMessage, ...errorDetails },
    });
  } catch (error) {
    req.log.error(error, `Error writing error response headers, giving up.`);
    res.end();
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
    case "HttpError":
      const statusCode = (err as HttpError).status;
      return {
        statusCode,
        statusMessage: `HTTP ${statusCode} ${http.STATUS_CODES[statusCode]}`,
        userMessage: `Reverse proxy error: ${err.message}`,
        type: "proxy_http_error",
      };
    case "BadRequestError":
      return {
        statusCode: 400,
        statusMessage: "Bad Request",
        userMessage: `Request is not valid. (${err.message})`,
        type: "proxy_bad_request",
      };
    case "NotFoundError":
      return {
        statusCode: 404,
        statusMessage: "Not Found",
        userMessage: `Requested resource not found. (${err.message})`,
        type: "proxy_not_found",
      };
    case "PaymentRequiredError":
      return {
        statusCode: 402,
        statusMessage: "No Keys Available",
        userMessage: err.message,
        type: "proxy_no_keys_available",
      };
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
    case "anthropic-chat":
      if (!body.content) {
        req.log.error(
          { body: JSON.stringify(body) },
          "Received empty Anthropic chat completion"
        );
        return "";
      }
      return body.content
        .map(({ text, type }: { type: string; text: string }) =>
          type === "text" ? text : `[Unsupported content type: ${type}]`
        )
        .join("\n");
    case "anthropic-text":
      if (!body.completion) {
        req.log.error(
          { body: JSON.stringify(body) },
          "Received empty Anthropic text completion"
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
    case "anthropic-chat":
    case "anthropic-text":
      // Anthropic confirms the model in the response, but AWS Claude doesn't.
      return body.model || req.body.model;
    case "google-ai":
      // Google doesn't confirm the model in the response.
      return req.body.model;
    default:
      assertNever(format);
  }
}
