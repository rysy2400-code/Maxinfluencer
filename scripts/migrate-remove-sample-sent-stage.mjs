/**
 * 移除 tiktok_campaign_execution.stage 枚举值 sample_sent：
 * - 将现有 sample_sent 行迁移为 pending_draft（寄样完成语义改由 last_event.sampleSentAt 表示）
 *
 * 用法：node scripts/migrate-remove-sample-sent-stage.mjs
 */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import { queryTikTok } from "../lib/db/mysql-tiktok.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
dotenv.config({ path: path.join(projectRoot, ".env") });
dotenv.config({ path: path.join(projectRoot, ".env.local") });

const ENUM_WITHOUT_SAMPLE_SENT = `
  ENUM(
    'pending_quote',
    'quote_submitted',
    'pending_sample',
    'pending_draft',
    'draft_submitted',
    'published',
    'quote_rejected'
  ) NOT NULL DEFAULT 'pending_quote' COMMENT '执行阶段'
`;

async function main() {
  console.log("[migrate sample_sent] Step 1: sample_sent → pending_draft，并补充 last_event.sampleSentAt …");
  const rows = await queryTikTok(
    `
    SELECT campaign_id, influencer_id, last_event
    FROM tiktok_campaign_execution
    WHERE stage = 'sample_sent'
  `,
    []
  );
  for (const row of rows || []) {
    let ev = row.last_event;
    if (typeof ev === "string") {
      try {
        ev = JSON.parse(ev);
      } catch {
        ev = {};
      }
    }
    if (!ev || typeof ev !== "object") ev = {};
    if (!ev.sampleSentAt) {
      ev.sampleSentAt = new Date().toISOString();
      ev.sampleSentMigrated = true;
    }
    await queryTikTok(
      `
      UPDATE tiktok_campaign_execution
      SET stage = 'pending_draft',
          last_event = ?,
          updated_at = NOW()
      WHERE campaign_id = ? AND influencer_id = ?
    `,
      [JSON.stringify(ev), row.campaign_id, row.influencer_id]
    );
  }
  console.log(`[migrate sample_sent] 已迁移行数: ${(rows || []).length}`);

  console.log("[migrate sample_sent] Step 2: 从 ENUM 中移除 sample_sent …");
  await queryTikTok(
    `ALTER TABLE tiktok_campaign_execution MODIFY COLUMN stage ${ENUM_WITHOUT_SAMPLE_SENT}`
  );
  console.log("[migrate sample_sent] ✅ 完成。");
}

main().catch((err) => {
  console.error("[migrate sample_sent] 失败:", err?.message || err);
  process.exit(1);
});
