import Database from "better-sqlite3";
import { v4 as uuidv4 } from "uuid";
import { config } from "../src/config";

function generateRandomIP() {
  return (
    Math.floor(Math.random() * 255) +
    "." +
    Math.floor(Math.random() * 255) +
    "." +
    Math.floor(Math.random() * 255) +
    "." +
    Math.floor(Math.random() * 255)
  );
}

function generateRandomDate() {
  const end = new Date();
  const start = new Date(end);
  start.setDate(end.getDate() - 90);
  const randomDate = new Date(
    start.getTime() + Math.random() * (end.getTime() - start.getTime())
  );
  return randomDate.toISOString();
}

function generateMockSHA256() {
  const characters = 'abcdef0123456789';
  let hash = '';

  for (let i = 0; i < 64; i++) {
    const randomIndex = Math.floor(Math.random() * characters.length);
    hash += characters[randomIndex];
  }

  return hash;
}

function getRandomModelFamily() {
  const modelFamilies = [
    "turbo",
    "gpt4",
    "gpt4-32k",
    "gpt4-turbo",
    "claude",
    "claude-opus",
    "gemini-pro",
    "mistral-tiny",
    "mistral-small",
    "mistral-medium",
    "mistral-large",
    "aws-claude",
    "aws-claude-opus",
    "gcp-claude",
    "gcp-claude-opus",
    "azure-turbo",
    "azure-gpt4",
    "azure-gpt4-32k",
    "azure-gpt4-turbo",
    "dall-e",
    "azure-dall-e",
  ];
  return modelFamilies[Math.floor(Math.random() * modelFamilies.length)];
}

(async () => {
  const db = new Database(config.sqliteDataPath);
  const numRows = 100;
  const insertStatement = db.prepare(`
  INSERT INTO events (type, ip, date, model, family, hashes, userToken, inputTokens, outputTokens)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

  const users = Array.from({ length: 10 }, () => uuidv4());
  function getRandomUser() {
    return users[Math.floor(Math.random() * users.length)];
  }

  const transaction = db.transaction(() => {
    for (let i = 0; i < numRows; i++) {
      insertStatement.run(
        "chat_completion",
        generateRandomIP(),
        generateRandomDate(),
        getRandomModelFamily() + "-" + Math.floor(Math.random() * 100),
        getRandomModelFamily(),
        Array.from(
          { length: Math.floor(Math.random() * 10) },
          generateMockSHA256
        ).join(","),
        getRandomUser(),
        Math.floor(Math.random() * 500),
        Math.floor(Math.random() * 6000)
      );
    }
  });

  transaction();

  console.log(`Inserted ${numRows} rows into the events table.`);
  db.close();
})();
