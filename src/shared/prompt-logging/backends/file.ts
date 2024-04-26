// stolen from https://gitgud.io/fiz1/oai-reverse-proxy

import { promises as fs } from "fs";
import * as path from "path";
import { USER_ASSETS_DIR, config } from "../../../config";
import { logger } from "../../../logger";
import { LogBackend, PromptLogEntry } from "../index";
import { glob } from "glob";

const MAX_FILE_SIZE = 100 * 1024 * 1024;

let currentFileNumber = 0;
let currentFilePath = "";
let currentFileSize = 0;

export { currentFileNumber };

export const fileBackend: LogBackend = {
  init: async (_onStop: () => void) => {
    try {
      await createNewLogFile();
    } catch (error) {
      logger.error("Error initializing file backend", error);
      throw error;
    }

    const files = glob.sync(
      path.join(USER_ASSETS_DIR, `${config.promptLoggingFilePrefix}*.jsonl`),
      { windowsPathsNoEscape: true }
    );
    const sorted = files.sort((a, b) => {
      const aNum = parseInt(path.basename(a).replace(/[^0-9]/g, ""), 10);
      const bNum = parseInt(path.basename(b).replace(/[^0-9]/g, ""), 10);
      return aNum - bNum;
    });

    if (sorted.length > 0) {
      const latestFile = sorted[sorted.length - 1];
      const stats = await fs.stat(latestFile);
      currentFileNumber = parseInt(
        path.basename(latestFile).replace(/[^0-9]/g, ""),
        10
      );
      currentFilePath = latestFile;
      currentFileSize = stats.size;
    }

    logger.info(
      { currentFileNumber, currentFilePath, currentFileSize },
      "File backend initialized"
    );
  },
  appendBatch: async (batch: PromptLogEntry[]) => {
    try {
      if (currentFileSize > MAX_FILE_SIZE) {
        await createNewLogFile();
      }

      const batchString =
        batch
          .map((entry) =>
            JSON.stringify({
              endpoint: entry.endpoint,
              model: entry.model,
              prompt: entry.promptRaw,
              response: entry.response,
            })
          )
          .join("\n") + "\n";
      const batchSizeBytes = Buffer.byteLength(batchString);
      const batchLines = batch.length;
      logger.debug(
        { batchLines, batchSizeBytes, currentFileSize, file: currentFilePath },
        "Appending batch to file"
      );
      await fs.appendFile(currentFilePath, batchString);
      currentFileSize += Buffer.byteLength(batchString);
    } catch (error) {
      logger.error("Error appending batch to file", error);
      throw error;
    }
  },
};

async function createNewLogFile() {
  currentFileNumber++;
  currentFilePath = path.join(
    USER_ASSETS_DIR,
    `${config.promptLoggingFilePrefix}${currentFileNumber}.jsonl`
  );
  currentFileSize = 0;

  await fs.writeFile(currentFilePath, "");
  logger.info(`Created new log file: ${currentFilePath}`);
}
