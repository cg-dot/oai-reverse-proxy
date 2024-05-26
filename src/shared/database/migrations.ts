import type sqlite3 from "better-sqlite3";

type Migration = {
  name: string;
  version: number;
  up: (db: sqlite3.Database) => void;
  down: (db: sqlite3.Database) => void;
};

export const migrations = [
  {
    name: "create db",
    version: 1,
    up: () => {},
    down: () => {},
  },
  {
    name: "add events table",
    version: 2,
    up: (db) => {
      db.exec(
        `CREATE TABLE IF NOT EXISTS events
         (
             id           INTEGER PRIMARY KEY AUTOINCREMENT,
             type         TEXT    NOT NULL,
             ip           TEXT    NOT NULL,
             date         TEXT    NOT NULL,
             model        TEXT    NOT NULL,
             family       TEXT    NOT NULL,
             hashes       TEXT    NOT NULL,
             userToken    TEXT    NOT NULL,
             inputTokens  INTEGER NOT NULL,
             outputTokens INTEGER NOT NULL
         )`
      );
    },
    down: (db) => db.exec("DROP TABLE events"),
  },
  {
    name: "add events indexes",
    version: 3,
    up: (db) => {
      // language=SQLite
      db.exec(
        `BEGIN;
        CREATE INDEX IF NOT EXISTS idx_events_userToken ON events (userToken);
        CREATE INDEX IF NOT EXISTS idx_events_ip ON events (ip);
        COMMIT;`
      );
    },
    down: (db) => {
      // language=SQLite
      db.exec(
        `BEGIN;
        DROP INDEX idx_events_userToken;
        DROP INDEX idx_events_ip;
        COMMIT;`
      );
    },
  },
] satisfies Migration[];
