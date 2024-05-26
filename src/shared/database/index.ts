import type sqlite3 from "better-sqlite3";
import { config } from "../../config";
import { logger } from "../../logger";
import { migrations } from "./migrations";

export const DATABASE_VERSION = 3;

let database: sqlite3.Database | undefined;
let log = logger.child({ module: "database" });

export function getDatabase(): sqlite3.Database {
  if (!database) {
    throw new Error("Sqlite database not initialized.");
  }
  return database;
}

export async function initializeDatabase() {
  if (!config.eventLogging) {
    return;
  }

  log.info("Initializing database...");

  const sqlite3 = await import("better-sqlite3");
  database = sqlite3.default(config.sqliteDataPath);
  migrateDatabase();
  database.pragma("journal_mode = WAL");
  log.info("Database initialized.");
}

export function migrateDatabase(
  targetVersion = DATABASE_VERSION,
  targetDb?: sqlite3.Database
) {
  const db = targetDb || getDatabase();

  const currentVersion = db.pragma("user_version", { simple: true });
  assertNumber(currentVersion);

  if (currentVersion === targetVersion) {
    log.info("No migrations to run.");
    return;
  }

  const direction = currentVersion < targetVersion ? "up" : "down";
  const pending = migrations
    .slice()
    .sort((a, b) =>
      direction === "up" ? a.version - b.version : b.version - a.version
    )
    .filter((m) =>
      direction === "up"
        ? m.version > currentVersion && m.version <= targetVersion
        : m.version > targetVersion && m.version <= currentVersion
    );

  if (pending.length === 0) {
    log.warn("No pending migrations found.");
    return;
  }

  for (const migration of pending) {
    const { version, name, up, down } = migration;
    if (
      (direction === "up" && version > currentVersion) ||
      (direction === "down" && version <= currentVersion)
    ) {
      if (direction === "up") {
        log.info({ name }, "Applying migration.");
        up(db);
        db.pragma("user_version = " + version);
      } else {
        log.info({ name }, "Reverting migration.");
        down(db);
        db.pragma("user_version = " + (version - 1));
      }
    }
  }

  log.info("Migrations applied.");
}

function assertNumber(value: unknown): asserts value is number {
  if (typeof value !== "number") {
    throw new Error("Expected number");
  }
}
export { EventLogEntry } from "./repos/event";
