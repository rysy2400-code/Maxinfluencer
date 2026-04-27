/**
 * 为任务与结果表补充 worker_ip 字段（若已存在则跳过）：
 * - tiktok_influencer_search_task.worker_ip
 * - tiktok_keyword_run_result.assigned_worker_ip
 */
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import { queryTikTok } from "../lib/db/mysql-tiktok.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
dotenv.config({ path: path.join(projectRoot, ".env") });
dotenv.config({ path: path.join(projectRoot, ".env.local") });

async function tryAlter(sql, okMsg, skipRegex) {
  try {
    await queryTikTok(sql);
    console.log(`✅ ${okMsg}`);
  } catch (e) {
    if (skipRegex.test(String(e?.message || ""))) {
      console.log(`⏭️ ${okMsg}（已存在，跳过）`);
      return;
    }
    throw e;
  }
}

async function main() {
  await tryAlter(
    `
    ALTER TABLE tiktok_influencer_search_task
    ADD COLUMN worker_ip VARCHAR(64) NULL COMMENT '执行机器 IP（可选）'
  `,
    "tiktok_influencer_search_task.worker_ip 已处理",
    /Duplicate column name/i
  );

  await tryAlter(
    `
    ALTER TABLE tiktok_keyword_run_result
    ADD COLUMN assigned_worker_ip VARCHAR(64) NULL COMMENT '执行机器 IP（可选）'
  `,
    "tiktok_keyword_run_result.assigned_worker_ip 已处理",
    /Duplicate column name/i
  );

  await tryAlter(
    `
    ALTER TABLE tiktok_influencer_search_task
    ADD INDEX idx_worker_host_ip_status (worker_host, worker_ip, status)
  `,
    "idx_worker_host_ip_status 已处理",
    /Duplicate key name/i
  );

  await tryAlter(
    `
    ALTER TABLE tiktok_keyword_run_result
    ADD INDEX idx_worker_ip_time (assigned_worker_host, assigned_worker_ip, created_at)
  `,
    "idx_worker_ip_time 已处理",
    /Duplicate key name/i
  );
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("❌ 失败:", err?.message || err);
    process.exit(1);
  });
