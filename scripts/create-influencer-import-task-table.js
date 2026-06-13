/**
 * 创建 tiktok_influencer_import_task 表
 *   node scripts/create-influencer-import-task-table.js
 */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";
import { queryTikTok } from "../lib/db/mysql-tiktok.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
dotenv.config({ path: path.join(projectRoot, ".env") });
dotenv.config({ path: path.join(projectRoot, ".env.local") });

function splitSqlStatements(sqlText) {
  const lines = String(sqlText || "").split("\n");
  const withoutComments = lines.map((line) => line.replace(/--.*$/, "").trimEnd()).join("\n");
  return withoutComments
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);
}

async function main() {
  const schemaPath = path.join(projectRoot, "lib/db/influencer-import-task-schema.sql");
  const sqlText = fs.readFileSync(schemaPath, "utf8");
  const statements = splitSqlStatements(sqlText);
  for (const stmt of statements) {
    await queryTikTok(stmt);
    console.log("[create-import-task-table] OK:", stmt.slice(0, 60).replace(/\s+/g, " "));
  }
  console.log("[create-import-task-table] done");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
