import { getDatabase } from "../index";

export interface EventLogEntry {
  date: string;
  ip: string;
  type: "chat_completion";
  model: string;
  family: string;
  /**
   * Prompt hashes are SHA256.
   * Each message is stripped of whitespace.
   * Then joined by <|im_sep|>
   * Then hashed.
   * First hash: Full prompt.
   * Next {trim} hashes: Hashes with last 1-{trim} messages removed.
   */
  hashes: string[];
  userToken: string;
  inputTokens: number;
  outputTokens: number;
}

export interface EventsRepo {
  getUserEvents: (
    userToken: string,
    { limit, cursor }: { limit: number; cursor?: string }
  ) => EventLogEntry[];
  logEvent: (payload: EventLogEntry) => void;
}

export const eventsRepo: EventsRepo = {
  getUserEvents: (userToken, { limit, cursor }) => {
    const db = getDatabase();
    const params = [];
    let sql = `
        SELECT *
        FROM events
        WHERE userToken = ?
    `;
    params.push(userToken);

    if (cursor) {
      sql += ` AND date < ?`;
      params.push(cursor);
    }

    sql += ` ORDER BY date DESC LIMIT ?`;
    params.push(limit);

    return db.prepare(sql).all(params).map(marshalEventLogEntry);
  },
  logEvent: (payload) => {
    const db = getDatabase();
    db.prepare(
      `
          INSERT INTO events(date, ip, type, model, family, hashes, userToken, inputTokens, outputTokens)
          VALUES (:date, :ip, :type, :model, :family, :hashes, :userToken, :inputTokens, :outputTokens)
      `
    ).run({
      date: payload.date,
      ip: payload.ip,
      type: payload.type,
      model: payload.model,
      family: payload.family,
      hashes: payload.hashes.join(","),
      userToken: payload.userToken,
      inputTokens: payload.inputTokens,
      outputTokens: payload.outputTokens,
    });
  },
};

function marshalEventLogEntry(row: any): EventLogEntry {
  return {
    date: row.date,
    ip: row.ip,
    type: row.type,
    model: row.model,
    family: row.family,
    hashes: row.hashes.split(","),
    userToken: row.userToken,
    inputTokens: parseInt(row.inputTokens),
    outputTokens: parseInt(row.outputTokens),
  };
}
