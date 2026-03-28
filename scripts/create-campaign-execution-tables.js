/**
 * 创建 Campaign 执行相关表：campaigns, tiktok_campaign_report_config, influencer_special_requests
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

async function createTables() {
  const schemaPath = path.join(__dirname, "../lib/db/campaign-execution-schema.sql");
  const sql = fs.readFileSync(schemaPath, "utf8");
  // 按 "CREATE TABLE" 分割，每段从 CREATE TABLE 到对应的 ");" 为一条语句
  const parts = sql.split(/\s*CREATE TABLE\s+/i);
  const statements = [];
  for (let i = 1; i < parts.length; i++) {
    const block = "CREATE TABLE " + parts[i].trim();
    const end = block.indexOf(");");
    if (end !== -1) {
      statements.push(block.substring(0, end + 2));
    }
  }

  for (const statement of statements) {
    const preview = statement.substring(0, 60).replace(/\s+/g, " ");
    console.log("执行:", preview + "...");
    await queryTikTok(statement);
    console.log("  OK");
  }

  console.log("\n✅ Campaign 执行相关表创建成功。");
  try {
    const tables = await queryTikTok("SHOW TABLES LIKE 'campaigns'");
    if (tables.length > 0) console.log("  - campaigns");
    const r = await queryTikTok("SHOW TABLES LIKE 'tiktok_campaign_report_config'");
    if (r.length > 0) console.log("  - tiktok_campaign_report_config");
    const s = await queryTikTok("SHOW TABLES LIKE 'influencer_special_requests'");
    if (s.length > 0) console.log("  - influencer_special_requests");
  } catch (e) {
    console.warn("(验证表存在时失败，可忽略):", e.message);
  }
  process.exit(0);
}

createTables().catch((err) => {
  console.error("❌ 创建表失败:", err.message);
  process.exit(1);
});
