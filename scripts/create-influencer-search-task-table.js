/**
 * 创建 tiktok_influencer_search_task 任务表。
 *
 * 用法：
 *   node scripts/create-influencer-search-task-table.js
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

async function main() {
  const schemaPath = path.join(
    __dirname,
    "../lib/db/influencer-search-task-schema.sql"
  );
  const sql = fs.readFileSync(schemaPath, "utf8");
  await queryTikTok(sql);
  console.log("✅ 已确保 tiktok_influencer_search_task 表存在。");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("❌ 创建 tiktok_influencer_search_task 失败:", err?.message || err);
    process.exit(1);
  });

