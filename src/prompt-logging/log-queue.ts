/* Queues incoming prompts/responses and periodically flushes them to configured
 * logging backend. */

import { logger } from "../logger";
import { PromptLogEntry } from ".";
import { sheets } from "./backends";

const FLUSH_INTERVAL = 1000 * 20; // 20 seconds
const MAX_BATCH_SIZE = 100;

const queue: PromptLogEntry[] = [];
const log = logger.child({ module: "log-queue" });

let started = false;
let timeoutId: NodeJS.Timeout | null = null;
let retrying = false;
let failedBatchCount = 0;

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
      await sheets.appendBatch(nextBatch);
      retrying = false;
    } catch (e: any) {
      if (retrying) {
        log.error(
          { message: e.message, stack: e.stack },
          "Failed twice to flush batch, discarding."
        );
        retrying = false;
        failedBatchCount++;
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
  try {
    await sheets.init(() => stop());
    log.info("Logging backend initialized.");
    started = true;
  } catch (e) {
    log.error(e, "Could not initialize logging backend.");
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
  if (failedBatchCount > 5) {
    log.error(
      { failedBatchCount },
      "Too many failed batches. Stopping prompt logging."
    );
    stop();
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
