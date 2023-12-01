/* Google Sheets backend for prompt logger.  Upon every flush, this backend
writes the batch to a Sheets spreadsheet. If the sheet becomes too large, it
will create a new sheet and continue writing there. 

This is essentially a really shitty ORM for Sheets. Absolutely no concurrency
support because it relies on local state to match up with the remote state. */

import { google, sheets_v4 } from "googleapis";
import type { CredentialBody } from "google-auth-library";
import type { GaxiosResponse } from "googleapis-common";
import { config } from "../../../config";
import { logger } from "../../../logger";
import { PromptLogEntry } from "..";

// There is always a sheet called __index__ which contains a list of all the
// other sheets. We use this rather than iterating over all the sheets in case
// the user needs to manually work with the spreadsheet.
// If no __index__ sheet exists, we will assume that the spreadsheet is empty
// and create one.

type IndexSheetModel = {
  /**
   * Stored in cell B2. Set on startup; if it changes, we assume that another
   * instance of the proxy is writing to the spreadsheet and stop.
   */
  lockId: string;
  /**
   * Data starts at row 4. Row 1-3 are headers
   */
  rows: { logSheetName: string; createdAt: string; rowCount: number }[];
};

type LogSheetModel = {
  sheetName: string;
  rows: {
    model: string;
    endpoint: string;
    promptRaw: string;
    promptFlattened: string;
    response: string;
  }[];
};

const MAX_ROWS_PER_SHEET = 2000;
const log = logger.child({ module: "sheets" });

let sheetsClient: sheets_v4.Sheets | null = null;
/** Called when log backend aborts to tell the log queue to stop. */
let stopCallback: (() => void) | null = null;
/** Lock/synchronization ID for this session. */
let lockId = Math.random().toString(36).substring(2, 15);
/** In-memory cache of the index sheet. */
let indexSheet: IndexSheetModel | null = null;
/** In-memory cache of the active log sheet. */
let activeLogSheet: LogSheetModel | null = null;

/**
 * Loads the __index__ sheet into memory. By default, asserts that the lock ID
 * has not changed since the start of the session.
 */
const loadIndexSheet = async (assertLockId = true) => {
  const client = sheetsClient!;
  const spreadsheetId = config.googleSheetsSpreadsheetId!;
  log.info({ assertLockId }, "Loading __index__ sheet.");
  const res = await client.spreadsheets.values.get({
    spreadsheetId: spreadsheetId,
    range: "__index__!A1:D",
    majorDimension: "ROWS",
  });
  const data = assertData(res);
  if (!data.values || data.values[2][0] !== "logSheetName") {
    log.error({ values: data.values }, "Unexpected format for __index__ sheet");
    throw new Error("Unexpected format for __index__ sheet");
  }

  if (assertLockId) {
    const lockIdCell = data.values[1][1];
    if (lockIdCell !== lockId) {
      log.error(
        { receivedLock: lockIdCell, expectedLock: lockId },
        "Another instance of the proxy is writing to the spreadsheet; stopping."
      );
      stop();
      throw new Error(`Lock ID assertion failed`);
    }
  }

  const rows = data.values.slice(3).map((row) => {
    return {
      logSheetName: row[0],
      createdAt: row[1],
      rowCount: row[2],
    };
  });
  indexSheet = { lockId, rows };
};

/** Creates empty __index__ sheet for a new spreadsheet. */
const createIndexSheet = async () => {
  const client = sheetsClient!;
  const spreadsheetId = config.googleSheetsSpreadsheetId!;
  log.info("Creating empty __index__ sheet.");
  const res = await client.spreadsheets.batchUpdate({
    spreadsheetId: spreadsheetId,
    requestBody: {
      requests: [
        {
          addSheet: {
            properties: {
              title: "__index__",
              gridProperties: { rowCount: 1, columnCount: 3 },
            },
          },
        },
      ],
    },
  });
  assertData(res);
  indexSheet = { lockId, rows: [] };
  await writeIndexSheet();
};

/** Writes contents of in-memory indexSheet to the remote __index__ sheet. */
const writeIndexSheet = async () => {
  const client = sheetsClient!;
  const spreadsheetId = config.googleSheetsSpreadsheetId!;
  const headerRows = [
    ["Don't edit this sheet while the server is running.", "", ""],
    ["Lock ID", lockId, ""],
    ["logSheetName", "createdAt", "rowCount"],
  ];
  const contentRows = indexSheet!.rows.map((row) => {
    return [row.logSheetName, row.createdAt, row.rowCount];
  });
  log.info("Persisting __index__ sheet.");
  await client.spreadsheets.values.batchUpdate({
    spreadsheetId: spreadsheetId,
    requestBody: {
      valueInputOption: "RAW",
      data: [
        { range: "__index__!A1:D", values: [...headerRows, ...contentRows] },
      ],
    },
  });
};

/** Creates a new log sheet, adds it to the index, and sets it as active. */
const createLogSheet = async () => {
  const client = sheetsClient!;
  const spreadsheetId = config.googleSheetsSpreadsheetId!;
  // Sheet name format is Log_YYYYMMDD_HHMMSS
  const sheetName = `Log_${new Date()
    .toISOString()
    // YYYY-MM-DDTHH:MM:SS.sssZ -> YYYYMMDD_HHMMSS
    .replace(/[-:.]/g, "")
    .replace(/T/, "_")
    .substring(0, 15)}`;

  log.info({ sheetName }, "Creating new log sheet.");
  const res = await client.spreadsheets.batchUpdate({
    spreadsheetId: spreadsheetId,
    requestBody: {
      requests: [
        {
          addSheet: {
            properties: {
              title: sheetName,
              gridProperties: { rowCount: MAX_ROWS_PER_SHEET, columnCount: 5 },
            },
          },
        },
      ],
    },
  });
  assertData(res);
  // Increase row/column size and wrap text for readability.
  const sheetId = res.data.replies![0].addSheet!.properties!.sheetId;
  await client.spreadsheets.batchUpdate({
    spreadsheetId: spreadsheetId,
    requestBody: {
      requests: [
        {
          repeatCell: {
            range: { sheetId },
            cell: {
              userEnteredFormat: {
                wrapStrategy: "WRAP",
                verticalAlignment: "TOP",
              },
            },
            fields: "*",
          },
        },
        {
          updateDimensionProperties: {
            range: {
              sheetId,
              dimension: "COLUMNS",
              startIndex: 3,
              endIndex: 5,
            },
            properties: { pixelSize: 500 },
            fields: "pixelSize",
          },
        },
        {
          updateDimensionProperties: {
            range: {
              sheetId,
              dimension: "ROWS",
              startIndex: 1,
            },
            properties: { pixelSize: 200 },
            fields: "pixelSize",
          },
        },
      ],
    },
  });
  await client.spreadsheets.values.batchUpdate({
    spreadsheetId: spreadsheetId,
    requestBody: {
      valueInputOption: "RAW",
      data: [
        {
          range: `${sheetName}!A1:E`,
          values: [
            ["model", "endpoint", "prompt json", "prompt string", "response"],
          ],
        },
      ],
    },
  });
  indexSheet!.rows.push({
    logSheetName: sheetName,
    createdAt: new Date().toISOString(),
    rowCount: 0,
  });
  await writeIndexSheet();
  activeLogSheet = { sheetName, rows: [] };
};

export const appendBatch = async (batch: PromptLogEntry[]) => {
  if (!activeLogSheet) {
    // Create a new log sheet if we don't have one yet.
    await createLogSheet();
  } else {
    // Check lock to ensure we're the only instance writing to the spreadsheet.
    await loadIndexSheet(true);
  }

  const client = sheetsClient!;
  const spreadsheetId = config.googleSheetsSpreadsheetId!;
  const sheetName = activeLogSheet!.sheetName;
  const newRows = batch.map((entry) => {
    return [
      entry.model,
      entry.endpoint,
      entry.promptRaw.slice(-50000),
      entry.promptFlattened.slice(-50000),
      entry.response.slice(0, 50000),
    ];
  });
  log.info({ sheetName, rowCount: newRows.length }, "Appending log batch.");
  const data = await client.spreadsheets.values.append({
    spreadsheetId: spreadsheetId,
    range: `${sheetName}!A1:D`,
    valueInputOption: "RAW",
    requestBody: { values: newRows, majorDimension: "ROWS" },
  });
  assertData(data);
  if (data.data.updates && data.data.updates.updatedRows) {
    const newRowCount = data.data.updates.updatedRows;
    log.info({ sheetName, rowCount: newRowCount }, "Successfully appended.");
    activeLogSheet!.rows = activeLogSheet!.rows.concat(
      newRows.map((row) => ({
        model: row[0],
        endpoint: row[1],
        promptRaw: row[2],
        promptFlattened: row[3],
        response: row[4],
      }))
    );
  } else {
    // We didn't receive an error but we didn't get any updates either.
    // We may need to create a new sheet and throw to make the queue retry the
    // batch.
    log.warn(
      { sheetName, rowCount: newRows.length },
      "No updates received from append. Creating new sheet and retrying."
    );
    await createLogSheet();
    throw new Error("No updates received from append.");
  }
  await finalizeBatch();
};

const finalizeBatch = async () => {
  const sheetName = activeLogSheet!.sheetName;
  const rowCount = activeLogSheet!.rows.length;
  const indexRow = indexSheet!.rows.find(
    ({ logSheetName }) => logSheetName === sheetName
  )!;
  indexRow.rowCount = rowCount;
  if (rowCount >= MAX_ROWS_PER_SHEET) {
    await createLogSheet(); // Also updates index sheet
  } else {
    await writeIndexSheet();
  }
  log.info({ sheetName, rowCount }, "Batch finalized.");
};

type LoadLogSheetArgs = {
  sheetName: string;
  /** The starting row to load. If omitted, loads all rows (expensive). */
  fromRow?: number;
};

/** Not currently used. */
export const loadLogSheet = async ({
  sheetName,
  fromRow = 2, // omit header row
}: LoadLogSheetArgs) => {
  const client = sheetsClient!;
  const spreadsheetId = config.googleSheetsSpreadsheetId!;

  const range = `${sheetName}!A${fromRow}:E`;
  const res = await client.spreadsheets.values.get({
    spreadsheetId: spreadsheetId,
    range,
  });
  const data = assertData(res);
  const values = data.values || [];
  const rows = values.slice(1).map((row) => {
    return {
      model: row[0],
      endpoint: row[1],
      promptRaw: row[2],
      promptFlattened: row[3],
      response: row[4],
    };
  });
  activeLogSheet = { sheetName, rows };
};

export const init = async (onStop: () => void) => {
  if (sheetsClient) {
    return;
  }
  if (!config.googleSheetsKey || !config.googleSheetsSpreadsheetId) {
    throw new Error(
      "Missing required Google Sheets config. Refer to documentation for setup instructions."
    );
  }

  log.info("Initializing Google Sheets backend.");
  const encodedCreds = config.googleSheetsKey;
  // encodedCreds is a base64-encoded JSON key from the GCP console.
  const creds: CredentialBody = JSON.parse(
    Buffer.from(encodedCreds, "base64").toString("utf8").trim()
  );
  const auth = new google.auth.GoogleAuth({
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
    credentials: creds,
  });
  sheetsClient = google.sheets({ version: "v4", auth });
  stopCallback = onStop;

  const sheetId = config.googleSheetsSpreadsheetId;
  const res = await sheetsClient.spreadsheets.get({
    spreadsheetId: sheetId,
  });
  if (!res.data) {
    const { status, statusText, headers } = res;
    log.error(
      {
        res: { status, statusText, headers },
        creds: {
          client_email: creds.client_email?.slice(0, 5) + "********",
          private_key: creds.private_key?.slice(0, 5) + "********",
        },
        sheetId: config.googleSheetsSpreadsheetId,
      },
      "Could not connect to Google Sheets."
    );
    stop();
    throw new Error("Could not connect to Google Sheets.");
  } else {
    const sheetTitle = res.data.properties?.title;
    log.info({ sheetId, sheetTitle }, "Connected to Google Sheets.");
  }

  // Load or create the index sheet and write the lockId to it.
  try {
    log.info("Loading index sheet.");
    await loadIndexSheet(false);
    await writeIndexSheet();
  } catch (e) {
    log.warn({ error: e.message }, "Could not load index sheet. Creating a new one.");
    await createIndexSheet();
  }
};

/** Called during some unrecoverable error to tell the log queue to stop. */
function stop() {
  log.warn("Stopping Google Sheets backend.");
  if (stopCallback) {
    stopCallback();
  }
  sheetsClient = null;
}

function assertData<T = sheets_v4.Schema$ValueRange>(res: GaxiosResponse<T>) {
  if (!res.data) {
    const { status, statusText, headers } = res;
    log.error(
      { res: { status, statusText, headers } },
      "Unexpected response from Google Sheets API."
    );
  }
  return res.data!;
}
