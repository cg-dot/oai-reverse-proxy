import { Request, Response } from "express";
import httpProxy from "http-proxy";
import { ZodError } from "zod";

const OPENAI_CHAT_COMPLETION_ENDPOINT = "/v1/chat/completions";
const ANTHROPIC_COMPLETION_ENDPOINT = "/v1/complete";

/** Returns true if we're making a request to a completion endpoint. */
export function isCompletionRequest(req: Request) {
  return (
    req.method === "POST" &&
    [OPENAI_CHAT_COMPLETION_ENDPOINT, ANTHROPIC_COMPLETION_ENDPOINT].some(
      (endpoint) => req.path.startsWith(endpoint)
    )
  );
}

export function writeErrorResponse(
  req: Request,
  res: Response,
  statusCode: number,
  errorPayload: Record<string, any>
) {
  const errorSource = errorPayload.error?.type.startsWith("proxy")
    ? "proxy"
    : "upstream";

  // If we're mid-SSE stream, send a data event with the error payload and end
  // the stream. Otherwise just send a normal error response.
  if (
    res.headersSent ||
    res.getHeader("content-type") === "text/event-stream"
  ) {
    const errorContent =
      statusCode === 403
        ? JSON.stringify(errorPayload)
        : JSON.stringify(errorPayload, null, 2);

    const msg = buildFakeSseMessage(
      `${errorSource} error (${statusCode})`,
      errorContent,
      req
    );
    res.write(msg);
    res.write(`data: [DONE]\n\n`);
    res.end();
  } else {
    res.status(statusCode).json(errorPayload);
  }
}

export const handleProxyError: httpProxy.ErrorCallback = (err, req, res) => {
  req.log.error({ err }, `Error during proxy request middleware`);
  handleInternalError(err, req as Request, res as Response);
};

export const handleInternalError = (
  err: Error,
  req: Request,
  res: Response
) => {
  try {
    const isZod = err instanceof ZodError;
    const isForbidden = err.name === "ForbiddenError";
    if (isZod) {
      writeErrorResponse(req, res, 400, {
        error: {
          type: "proxy_validation_error",
          proxy_note: `Reverse proxy couldn't validate your request when trying to transform it. Your client may be sending invalid data.`,
          issues: err.issues,
          stack: err.stack,
          message: err.message,
        },
      });
    } else if (isForbidden) {
      // Spoofs a vaguely threatening OpenAI error message. Only invoked by the
      // block-zoomers rewriter to scare off tiktokers.
      writeErrorResponse(req, res, 403, {
        error: {
          type: "organization_account_disabled",
          code: "policy_violation",
          param: null,
          message: err.message,
        },
      });
    } else {
      writeErrorResponse(req, res, 500, {
        error: {
          type: "proxy_rewriter_error",
          proxy_note: `Reverse proxy encountered an error before it could reach the upstream API.`,
          message: err.message,
          stack: err.stack,
        },
      });
    }
  } catch (e) {
    req.log.error(
      { error: e },
      `Error writing error response headers, giving up.`
    );
  }
};

export function buildFakeSseMessage(
  type: string,
  string: string,
  req: Request
) {
  let fakeEvent;
  const useBackticks = !type.includes("403");
  const msgContent = useBackticks
    ? `\`\`\`\n[${type}: ${string}]\n\`\`\`\n`
    : `[${type}: ${string}]`;

  if (req.inboundApi === "anthropic") {
    fakeEvent = {
      completion: msgContent,
      stop_reason: type,
      truncated: false, // I've never seen this be true
      stop: null,
      model: req.body?.model,
      log_id: "proxy-req-" + req.id,
    };
  } else {
    fakeEvent = {
      id: "chatcmpl-" + req.id,
      object: "chat.completion.chunk",
      created: Date.now(),
      model: req.body?.model,
      choices: [
        {
          delta: { content: msgContent },
          index: 0,
          finish_reason: type,
        },
      ],
    };
  }
  return `data: ${JSON.stringify(fakeEvent)}\n\n`;
}
