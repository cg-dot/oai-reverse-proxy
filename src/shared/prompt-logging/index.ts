/* Logs prompts and model responses to a persistent storage backend, if enabled.
Since the proxy is generally deployed to free-tier services, our options for
persistent storage are pretty limited. We'll use Google Sheets as a makeshift
database for now. 

Due to the limitations of Google Sheets, we'll queue up log entries and flush
them to the API periodically. */

export interface PromptLogEntry {
  model: string;
  endpoint: string;
  /** JSON prompt passed to the model */
  promptRaw: string;
  /** Prompt with user and assistant messages flattened into a single string */
  promptFlattened: string;
  response: string;
  // TODO: temperature, top_p, top_k, etc.
}

export interface LogBackend {
  init: (onStop: () => void) => Promise<void>;
  appendBatch: (batch: PromptLogEntry[]) => Promise<void>;
}

export * as logQueue from "./log-queue";
export * as eventLogger from "./event-logger";
