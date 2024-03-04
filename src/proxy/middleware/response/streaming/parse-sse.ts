export type ServerSentEvent = { id?: string; type?: string; data: string };

/** Given a string of SSE data, parse it into a `ServerSentEvent` object. */
export function parseEvent(event: string) {
  const buffer: ServerSentEvent = { data: "" };
  return event.split(/\r?\n/).reduce(parseLine, buffer);
}

function parseLine(event: ServerSentEvent, line: string) {
  const separator = line.indexOf(":");
  const field = separator === -1 ? line : line.slice(0, separator);
  const value = separator === -1 ? "" : line.slice(separator + 1);

  switch (field) {
    case "id":
      event.id = value.trim();
      break;
    case "event":
      event.type = value.trim();
      break;
    case "data":
      event.data += value.trimStart();
      break;
    default:
      break;
  }

  return event;
}
