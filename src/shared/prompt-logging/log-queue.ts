/* Queues incoming prompts/responses and periodically flushes them to configured
 * logging backend. */

import { logger } from "../../logger";
import { LogBackend, PromptLogEntry } from ".";
import { sheets, file } from "./backends";
import { config } from "../../config";
import { assertNever } from "../utils";

const FLUSH_INTERVAL = 1000 * 10;
const MAX_BATCH_SIZE = 25;

const queue: PromptLogEntry[] = [];
const log = logger.child({ module: "log-queue" });

let started = false;
let timeoutId: NodeJS.Timeout | null = null;
let retrying = false;
let consecutiveFailedBatches = 0;
let backend: LogBackend;

export const enqueue = (payload: PromptLogEntry) => {
  if (!started) {
    log.warn("Log queue not started, discarding incoming log entry.");
    return;
  }
  queue.push(payload);
};

export const flush = async () => {
  if (!started) {
    return;
  }

  if (queue.length > 0) {
    const batchSize = Math.min(MAX_BATCH_SIZE, queue.length);
    const nextBatch = queue.splice(0, batchSize);
    log.info({ size: nextBatch.length }, "Submitting new batch.");
    try {
      await backend.appendBatch(nextBatch);
      retrying = false;
      consecutiveFailedBatches = 0;
    } catch (e: any) {
      if (retrying) {
        log.error(
          { message: e.message, stack: e.stack },
          "Failed twice to flush batch, discarding."
        );
        retrying = false;
        consecutiveFailedBatches++;
      } else {
        // Put the batch back at the front of the queue and try again
        log.warn(
          { message: e.message, stack: e.stack },
          "Failed to flush batch. Retrying."
        );
        queue.unshift(...nextBatch);
        retrying = true;
        setImmediate(() => flush());
        return;
      }
    }
  }

  const useHalfInterval = queue.length > MAX_BATCH_SIZE / 2;
  scheduleFlush(useHalfInterval);
};

export const start = async () => {
  const type = config.promptLoggingBackend!;
  try {
    switch (type) {
      case "google_sheets":
        backend = sheets;
        await sheets.init(() => stop());
        break;
      case "file":
        backend = file;
        await file.init(() => stop());
        break;
      default:
        assertNever(type)
    }
    log.info("Logging backend initialized.");
    started = true;
  } catch (e) {
    log.error({ error: e.message }, "Could not initialize logging backend.");
    return;
  }
  scheduleFlush();
};

export const stop = () => {
  if (timeoutId) {
    clearTimeout(timeoutId);
  }
  log.info("Stopping log queue.");
  started = false;
};

const scheduleFlush = (halfInterval = false) => {
  if (consecutiveFailedBatches > 3) {
    // TODO: may cause memory issues on busy servers, though if we crash that
    // may actually fix the problem with logs randomly not being flushed.
    const oneMinute = 60 * 1000;
    const maxBackoff = 10 * oneMinute;
    const backoff = Math.min(consecutiveFailedBatches * oneMinute, maxBackoff);
    timeoutId = setTimeout(() => {
      flush();
    }, backoff);
    log.warn(
      { consecutiveFailedBatches, backoffMs: backoff },
      "Failed to flush 3 batches in a row, pausing for a few minutes."
    );
    return;
  }

  if (halfInterval) {
    log.warn(
      { queueSize: queue.length },
      "Queue is falling behind, switching to faster flush interval."
    );
  }

  timeoutId = setTimeout(
    () => {
      flush();
    },
    halfInterval ? FLUSH_INTERVAL / 2 : FLUSH_INTERVAL
  );
};
