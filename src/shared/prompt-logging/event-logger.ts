import { config } from "../../config";
import type { EventLogEntry } from "../database";
import { eventsRepo } from "../database/repos/event";

export const logEvent = (payload: Omit<EventLogEntry, "date">) => {
  if (!config.eventLogging) {
    return;
  }
  eventsRepo.logEvent({ ...payload, date: new Date().toISOString() });
};
