import { Request, Response } from "express";
import httpProxy from "http-proxy";
import { ZodError } from "zod";
import { generateErrorMessage } from "zod-error";
import { buildFakeSse } from "../../shared/streaming";
import { assertNever } from "../../shared/utils";
import { QuotaExceededError } from "./request/apply-quota-limits";

const OPENAI_CHAT_COMPLETION_ENDPOINT = "/v1/chat/completions";
const OPENAI_TEXT_COMPLETION_ENDPOINT = "/v1/completions";
const OPENAI_EMBEDDINGS_ENDPOINT = "/v1/embeddings";
const ANTHROPIC_COMPLETION_ENDPOINT = "/v1/complete";

/** Returns true if we're making a request to a completion endpoint. */
export function isCompletionRequest(req: Request) {
  // 99% sure this function is not needed anymore
  return (
    req.method === "POST" &&
    [
      OPENAI_CHAT_COMPLETION_ENDPOINT,
      OPENAI_TEXT_COMPLETION_ENDPOINT,
      ANTHROPIC_COMPLETION_ENDPOINT,
    ].some((endpoint) => req.path.startsWith(endpoint))
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
  errorPayload: Record<string, any>
) {
  const errorSource = errorPayload.error?.type?.startsWith("proxy")
    ? "proxy"
    : "upstream";

  // If we're mid-SSE stream, send a data event with the error payload and end
  // the stream. Otherwise just send a normal error response.
  if (
    res.headersSent ||
    String(res.getHeader("content-type")).startsWith("text/event-stream")
  ) {
    const errorTitle = `${errorSource} error (${statusCode})`;
    const errorContent = JSON.stringify(errorPayload, null, 2);
    const msg = buildFakeSse(errorTitle, errorContent, req);
    res.write(msg);
    res.write(`data: [DONE]\n\n`);
    res.end();
  } else {
    if (req.debug && errorPayload.error) {
      errorPayload.error.proxy_tokenizer_debug_info = req.debug;
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
    const { status, userMessage, ...errorDetails } = classifyError(err);
    writeErrorResponse(req, res, status, {
      error: { message: userMessage, ...errorDetails },
    });
  } catch (error) {
    req.log.error(error, `Error writing error response headers, giving up.`);
  }
};

function classifyError(err: Error): {
  /** HTTP status code returned to the client. */
  status: number;
  /** Message displayed to the user. */
  userMessage: string;
  /** Short error type, e.g. "proxy_validation_error". */
  type: string;
} & Record<string, any> {
  const defaultError = {
    status: 500,
    userMessage: `Reverse proxy encountered an unexpected error. (${err.message})`,
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
          return `At '${rest.pathComponent}', ${issue.message}`;
        },
      });
      return { status: 400, userMessage, type: "proxy_validation_error" };
    case "ForbiddenError":
      // Mimics a ban notice from OpenAI, thrown when blockZoomerOrigins blocks
      // a request.
      return {
        status: 403,
        userMessage: `Your account has been disabled for violating our terms of service.`,
        type: "organization_account_disabled",
        code: "policy_violation",
      };
    case "QuotaExceededError":
      return {
        status: 429,
        userMessage: `You've exceeded your token quota for this model type.`,
        type: "proxy_quota_exceeded",
        info: (err as QuotaExceededError).quotaInfo,
      };
    case "Error":
      if ("code" in err) {
        switch (err.code) {
          case "ENOTFOUND":
            return {
              status: 502,
              userMessage: `Reverse proxy encountered a DNS error while trying to connect to the upstream service.`,
              type: "proxy_network_error",
              code: err.code,
            };
          case "ECONNREFUSED":
            return {
              status: 502,
              userMessage: `Reverse proxy couldn't connect to the upstream service.`,
              type: "proxy_network_error",
              code: err.code,
            };
          case "ECONNRESET":
            return {
              status: 504,
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
      return body.choices[0].message.content;
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
    case "google-palm":
      return body.candidates[0].output;
    default:
      assertNever(format);
  }
}

export function getModelFromBody(req: Request, body: Record<string, any>) {
  const format = req.outboundApi;
  switch (format) {
    case "openai":
    case "openai-text":
      return body.model;
    case "anthropic":
      // Anthropic confirms the model in the response, but AWS Claude doesn't.
      return body.model || req.body.model;
    case "google-palm":
      // Google doesn't confirm the model in the response.
      return req.body.model;
    default:
      assertNever(format);
  }
}
