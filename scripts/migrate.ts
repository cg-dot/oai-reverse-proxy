import Database from "better-sqlite3";
import { DATABASE_VERSION, migrateDatabase } from "../src/shared/database";
import { logger } from "../src/logger";
import { config } from "../src/config";

const log = logger.child({ module: "scripts/migrate" });

async function runMigration() {
  let targetVersion = Number(process.argv[2]) || undefined;

  if (!targetVersion) {
    log.info("Enter target version or leave empty to use the latest version.");
    process.stdin.resume();
    process.stdin.setEncoding("utf8");
    const input = await new Promise<string>((resolve) => {
      process.stdin.on("data", (text) => {
        resolve((String(text) || "").trim());
      });
    });
    process.stdin.pause();
    targetVersion = Number(input);
    if (!targetVersion) {
      targetVersion = DATABASE_VERSION;
    }
  }

  const db = new Database(config.sqliteDataPath, {
    verbose: (msg, ...args) => log.debug({ args }, String(msg)),
  });

  const currentVersion = db.pragma("user_version", { simple: true });
  log.info({ currentVersion, targetVersion }, "Running migrations.");
  migrateDatabase(targetVersion, db);
}

runMigration().catch((error) => {
  log.error(error, "Migration failed.");
  process.exit(1);
});
