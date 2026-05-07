/**
 * 一次性迁移：tiktok_campaign_execution.stage
 * - 将 failed 改为 quote_rejected（不再保留 failed 枚举值）
 *
 * 用法：在项目根目录执行
 *   node scripts/migrate-execution-stage-failed-to-quote-rejected.mjs
 */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import { queryTikTok } from "../lib/db/mysql-tiktok.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
dotenv.config({ path: path.join(projectRoot, ".env") });
dotenv.config({ path: path.join(projectRoot, ".env.local") });

const ENUM_WITH_BOTH = `
  ENUM(
    'pending_quote',
    'quote_submitted',
    'pending_sample',
    'sample_sent',
    'pending_draft',
    'draft_submitted',
    'published',
    'quote_rejected',
    'failed'
  ) NOT NULL DEFAULT 'pending_quote' COMMENT '执行阶段'
`;

const ENUM_FINAL = `
  ENUM(
    'pending_quote',
    'quote_submitted',
    'pending_sample',
    'sample_sent',
    'pending_draft',
    'draft_submitted',
    'published',
    'quote_rejected'
  ) NOT NULL DEFAULT 'pending_quote' COMMENT '执行阶段'
`;

async function main() {
  console.log("[migrate] Step 1: 扩展 ENUM（加入 quote_rejected，暂保留 failed）…");
  await queryTikTok(
    `ALTER TABLE tiktok_campaign_execution MODIFY COLUMN stage ${ENUM_WITH_BOTH}`
  );

  console.log("[migrate] Step 2: UPDATE failed → quote_rejected …");
  const upd = await queryTikTok(
    `UPDATE tiktok_campaign_execution SET stage = 'quote_rejected' WHERE stage = 'failed'`
  );
  const n = typeof upd?.affectedRows === "number" ? upd.affectedRows : 0;
  console.log(`[migrate] 已更新行数: ${n}`);

  console.log("[migrate] Step 3: 从 ENUM 中移除 failed …");
  await queryTikTok(
    `ALTER TABLE tiktok_campaign_execution MODIFY COLUMN stage ${ENUM_FINAL}`
  );

  console.log("[migrate] ✅ 完成。");
}

main().catch((err) => {
  console.error("[migrate] 失败:", err?.message || err);
  process.exit(1);
});
