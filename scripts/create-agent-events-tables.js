import { readFile } from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import mysqlModule from "../lib/db/mysql.js";

const { queryTikTok, endTikTokPool } = mysqlModule;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function main() {
  const schemaPath = path.join(
    __dirname,
    "..",
    "lib",
    "db",
    "influencer-email-events-schema.sql"
  );
  const sql = await readFile(schemaPath, "utf8");

  // 这里只执行我们关心的两个 Agent 事件表的建表语句
  const stmts = sql
    .split(";")
    .map((s) => s.trim())
    .filter(
      (s) =>
        s &&
        (/CREATE TABLE IF NOT EXISTS tiktok_influencer_agent_event/i.test(s) ||
          /CREATE TABLE IF NOT EXISTS tiktok_advertiser_agent_event/i.test(s))
    );

  if (!stmts.length) {
    console.log("No agent event table definitions found in schema file.");
    return;
  }

  for (const stmt of stmts) {
    console.log("Executing:\n", stmt.substring(0, 200), "...");
    await queryTikTok(stmt, []);
  }

  console.log("Agent event tables ensured.");
}

main()
  .catch((err) => {
    console.error("Failed to create agent event tables:", err);
    process.exitCode = 1;
  })
  .finally(() => {
    endTikTokPool();
  });

