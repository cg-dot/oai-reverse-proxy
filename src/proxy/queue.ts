/**
 * Very scuffed request queue. OpenAI's GPT-4 keys have a very strict rate limit
 * of 40000 generated tokens per minute. We don't actually know how many tokens
 * a given key has generated, so our queue will simply retry requests that fail
 * with a non-billing related 429 over and over again until they succeed.
 *
 * Dequeueing can operate in one of two modes:
 * - 'fair': requests are dequeued in the order they were enqueued.
 * - 'random': requests are dequeued randomly, not really a queue at all.
 *
 * When a request to a proxied endpoint is received, we create a closure around
 * the call to http-proxy-middleware and attach it to the request. This allows
 * us to pause the request until we have a key available. Further, if the
 * proxied request encounters a retryable error, we can simply put the request
 * back in the queue and it will be retried later using the same closure.
 */

import type { Handler, Request } from "express";
import { config, DequeueMode } from "../config";
import { keyPool, SupportedModel } from "../key-management";
import { logger } from "../logger";
import { AGNAI_DOT_CHAT_IP } from "./rate-limit";
import { buildFakeSseMessage } from "./middleware/common";

export type QueuePartition = "claude" | "turbo" | "gpt-4";

const queue: Request[] = [];
const log = logger.child({ module: "request-queue" });

let dequeueMode: DequeueMode = "fair";

/** Maximum number of queue slots for Agnai.chat requests. */
const AGNAI_CONCURRENCY_LIMIT = 15;
/** Maximum number of queue slots for individual users. */
const USER_CONCURRENCY_LIMIT = 1;

/**
 * Returns a unique identifier for a request. This is used to determine if a
 * request is already in the queue.
 * This can be (in order of preference):
 * - user token assigned by the proxy operator
 * - x-risu-tk header, if the request is from RisuAI.xyz
 * - IP address
 */
function getIdentifier(req: Request) {
  if (req.user) {
    return req.user.token;
  }
  if (req.risuToken) {
    return req.risuToken;
  }
  return req.ip;
}

const sameUserPredicate = (incoming: Request) => (queued: Request) => {
  const queuedId = getIdentifier(queued);
  const incomingId = getIdentifier(incoming);
  return queuedId === incomingId;
};

export function enqueue(req: Request) {
  const enqueuedRequestCount = queue.filter(sameUserPredicate(req)).length;
  let isGuest = req.user?.token === undefined;

  // All Agnai.chat requests come from the same IP, so we allow them to have
  // more spots in the queue. Can't make it unlimited because people will
  // intentionally abuse it.
  // Authenticated users always get a single spot in the queue.
  const maxConcurrentQueuedRequests =
    isGuest && req.ip === AGNAI_DOT_CHAT_IP
      ? AGNAI_CONCURRENCY_LIMIT
      : USER_CONCURRENCY_LIMIT;
  if (enqueuedRequestCount >= maxConcurrentQueuedRequests) {
    if (req.ip === AGNAI_DOT_CHAT_IP) {
      // Re-enqueued requests are not counted towards the limit since they
      // already made it through the queue once.
      if (req.retryCount === 0) {
        throw new Error("Too many agnai.chat requests are already queued");
      }
    } else {
      throw new Error("Your IP or token already has a request in the queue");
    }
  }

  queue.push(req);
  req.queueOutTime = 0;

  // shitty hack to remove hpm's event listeners on retried requests
  removeProxyMiddlewareEventListeners(req);

  // If the request opted into streaming, we need to register a heartbeat
  // handler to keep the connection alive while it waits in the queue. We
  // deregister the handler when the request is dequeued.
  if (req.body.stream === "true" || req.body.stream === true) {
    const res = req.res!;
    if (!res.headersSent) {
      initStreaming(req);
    }
    req.heartbeatInterval = setInterval(() => {
      if (process.env.NODE_ENV === "production") {
        req.res!.write(": queue heartbeat\n\n");
      } else {
        req.log.info(`Sending heartbeat to request in queue.`);
        const partition = getPartitionForRequest(req);
        const avgWait = Math.round(getEstimatedWaitTime(partition) / 1000);
        const currentDuration = Math.round((Date.now() - req.startTime) / 1000);
        const debugMsg = `queue length: ${queue.length}; elapsed time: ${currentDuration}s; avg wait: ${avgWait}s`;
        req.res!.write(buildFakeSseMessage("heartbeat", debugMsg, req));
      }
    }, 10000);
  }

  // Register a handler to remove the request from the queue if the connection
  // is aborted or closed before it is dequeued.
  const removeFromQueue = () => {
    req.log.info(`Removing aborted request from queue.`);
    const index = queue.indexOf(req);
    if (index !== -1) {
      queue.splice(index, 1);
    }
    if (req.heartbeatInterval) {
      clearInterval(req.heartbeatInterval);
    }
  };
  req.onAborted = removeFromQueue;
  req.res!.once("close", removeFromQueue);

  if (req.retryCount ?? 0 > 0) {
    req.log.info({ retries: req.retryCount }, `Enqueued request for retry.`);
  } else {
    req.log.info(`Enqueued new request.`);
  }
}

function getPartitionForRequest(req: Request): QueuePartition {
  // There is a single request queue, but it is partitioned by model and API
  // provider.
  // - claude: requests for the Anthropic API, regardless of model
  // - gpt-4: requests for the OpenAI API, specifically for GPT-4 models
  // - turbo: effectively, all other requests
  const provider = req.outboundApi;
  const model = (req.body.model as SupportedModel) ?? "gpt-3.5-turbo";
  if (provider === "anthropic") {
    return "claude";
  }
  if (provider === "openai" && model.startsWith("gpt-4")) {
    return "gpt-4";
  }
  return "turbo";
}

function getQueueForPartition(partition: QueuePartition): Request[] {
  return queue.filter((req) => getPartitionForRequest(req) === partition);
}

export function dequeue(partition: QueuePartition): Request | undefined {
  const modelQueue = getQueueForPartition(partition);

  if (modelQueue.length === 0) {
    return undefined;
  }

  let req: Request;

  if (dequeueMode === "fair") {
    // Dequeue the request that has been waiting the longest
    req = modelQueue.reduce((prev, curr) =>
      prev.startTime < curr.startTime ? prev : curr
    );
  } else {
    // Dequeue a random request
    const index = Math.floor(Math.random() * modelQueue.length);
    req = modelQueue[index];
  }
  queue.splice(queue.indexOf(req), 1);

  if (req.onAborted) {
    req.res!.off("close", req.onAborted);
    req.onAborted = undefined;
  }

  if (req.heartbeatInterval) {
    clearInterval(req.heartbeatInterval);
  }

  // Track the time leaving the queue now, but don't add it to the wait times
  // yet because we don't know if the request will succeed or fail. We track
  // the time now and not after the request succeeds because we don't want to
  // include the model processing time.
  req.queueOutTime = Date.now();
  return req;
}

/**
 * Naive way to keep the queue moving by continuously dequeuing requests. Not
 * ideal because it limits throughput but we probably won't have enough traffic
 * or keys for this to be a problem.  If it does we can dequeue multiple
 * per tick.
 **/
function processQueue() {
  // This isn't completely correct, because a key can service multiple models.
  // Currently if a key is locked out on one model it will also stop servicing
  // the others, because we only track one rate limit per key.
  const gpt4Lockout = keyPool.getLockoutPeriod("gpt-4");
  const turboLockout = keyPool.getLockoutPeriod("gpt-3.5-turbo");
  const claudeLockout = keyPool.getLockoutPeriod("claude-v1");

  const reqs: (Request | undefined)[] = [];
  if (gpt4Lockout === 0) {
    reqs.push(dequeue("gpt-4"));
  }
  if (turboLockout === 0) {
    reqs.push(dequeue("turbo"));
  }
  if (claudeLockout === 0) {
    reqs.push(dequeue("claude"));
  }

  reqs.filter(Boolean).forEach((req) => {
    if (req?.proceed) {
      req.log.info({ retries: req.retryCount }, `Dequeuing request.`);
      req.proceed();
    }
  });
  setTimeout(processQueue, 50);
}

/**
 * Kill stalled requests after 5 minutes, and remove tracked wait times after 2
 * minutes.
 **/
function cleanQueue() {
  const now = Date.now();
  const oldRequests = queue.filter(
    (req) => now - (req.startTime ?? now) > 5 * 60 * 1000
  );
  oldRequests.forEach((req) => {
    req.log.info(`Removing request from queue after 5 minutes.`);
    killQueuedRequest(req);
  });

  const index = waitTimes.findIndex(
    (waitTime) => now - waitTime.end > 300 * 1000
  );
  const removed = waitTimes.splice(0, index + 1);
  log.trace(
    { stalledRequests: oldRequests.length, prunedWaitTimes: removed.length },
    `Cleaning up request queue.`
  );
  setTimeout(cleanQueue, 20 * 1000);
}

export function start() {
  processQueue();
  cleanQueue();
  log.info(`Started request queue.`);
}

let waitTimes: { partition: QueuePartition; start: number; end: number }[] = [];

/** Adds a successful request to the list of wait times. */
export function trackWaitTime(req: Request) {
  waitTimes.push({
    partition: getPartitionForRequest(req),
    start: req.startTime!,
    end: req.queueOutTime ?? Date.now(),
  });
}

/** Returns average wait time in milliseconds. */
export function getEstimatedWaitTime(partition: QueuePartition) {
  const now = Date.now();
  const recentWaits = waitTimes.filter(
    (wt) => wt.partition === partition && now - wt.end < 300 * 1000
  );
  if (recentWaits.length === 0) {
    return 0;
  }

  return (
    recentWaits.reduce((sum, wt) => sum + wt.end - wt.start, 0) /
    recentWaits.length
  );
}

export function getQueueLength(partition: QueuePartition | "all" = "all") {
  if (partition === "all") {
    return queue.length;
  }
  const modelQueue = getQueueForPartition(partition);
  return modelQueue.length;
}

export function createQueueMiddleware(proxyMiddleware: Handler): Handler {
  return (req, res, next) => {
    if (config.queueMode === "none") {
      return proxyMiddleware(req, res, next);
    }

    req.proceed = () => {
      proxyMiddleware(req, res, next);
    };

    try {
      enqueue(req);
    } catch (err: any) {
      req.res!.status(429).json({
        type: "proxy_error",
        message: err.message,
        stack: err.stack,
        proxy_note: `Only one request can be queued at a time. If you don't have another request queued, your IP or user token might be in use by another request.`,
      });
    }
  };
}

function killQueuedRequest(req: Request) {
  if (!req.res || req.res.writableEnded) {
    req.log.warn(`Attempted to terminate request that has already ended.`);
    return;
  }
  const res = req.res;
  try {
    const message = `Your request has been terminated by the proxy because it has been in the queue for more than 5 minutes. The queue is currently ${queue.length} requests long.`;
    if (res.headersSent) {
      const fakeErrorEvent = buildFakeSseMessage(
        "proxy queue error",
        message,
        req
      );
      res.write(fakeErrorEvent);
      res.end();
    } else {
      res.status(500).json({ error: message });
    }
  } catch (e) {
    req.log.error(e, `Error killing stalled request.`);
  }
}

function initStreaming(req: Request) {
  req.log.info(`Initiating streaming for new queued request.`);
  const res = req.res!;
  res.statusCode = 200;
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no"); // nginx-specific fix
  res.flushHeaders();
  res.write("\n");
  res.write(": joining queue\n\n");
}

/**
 * http-proxy-middleware attaches a bunch of event listeners to the req and
 * res objects which causes problems with our approach to re-enqueuing failed
 * proxied requests. This function removes those event listeners.
 * We don't have references to the original event listeners, so we have to
 * look through the list and remove HPM's listeners by looking for particular
 * strings in the listener functions. This is an astoundingly shitty way to do
 * this, but it's the best I can come up with.
 */
function removeProxyMiddlewareEventListeners(req: Request) {
  // node_modules/http-proxy-middleware/dist/plugins/default/debug-proxy-errors-plugin.js:29
  // res.listeners('close')
  const RES_ONCLOSE = `Destroying proxyRes in proxyRes close event`;
  // node_modules/http-proxy-middleware/dist/plugins/default/debug-proxy-errors-plugin.js:19
  // res.listeners('error')
  const RES_ONERROR = `Socket error in proxyReq event`;
  // node_modules/http-proxy/lib/http-proxy/passes/web-incoming.js:146
  // req.listeners('aborted')
  const REQ_ONABORTED = `proxyReq.abort()`;
  // node_modules/http-proxy/lib/http-proxy/passes/web-incoming.js:156
  // req.listeners('error')
  const REQ_ONERROR = `if (req.socket.destroyed`;

  const res = req.res!;

  const resOnClose = res
    .listeners("close")
    .find((listener) => listener.toString().includes(RES_ONCLOSE));
  if (resOnClose) {
    res.removeListener("close", resOnClose as any);
  }

  const resOnError = res
    .listeners("error")
    .find((listener) => listener.toString().includes(RES_ONERROR));
  if (resOnError) {
    res.removeListener("error", resOnError as any);
  }

  const reqOnAborted = req
    .listeners("aborted")
    .find((listener) => listener.toString().includes(REQ_ONABORTED));
  if (reqOnAborted) {
    req.removeListener("aborted", reqOnAborted as any);
  }

  const reqOnError = req
    .listeners("error")
    .find((listener) => listener.toString().includes(REQ_ONERROR));
  if (reqOnError) {
    req.removeListener("error", reqOnError as any);
  }
}
