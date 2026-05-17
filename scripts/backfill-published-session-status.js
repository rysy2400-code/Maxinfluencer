/**
 * 修复：context 已标记 published 且存在 tiktok_campaign，但会话 status 仍为 draft 的记录。
 * 典型原因：链式调用 campaign_publish_agent 时未写库（已在 agent-router 修复）。
 *
 * 使用：node scripts/backfill-published-session-status.js
 */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import { queryTikTok } from "../lib/db/mysql-tiktok.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
dotenv.config({ path: path.join(projectRoot, ".env") });
dotenv.config({ path: path.join(projectRoot, ".env.local") });

const SESSION_TABLE = "tiktok_campaign_sessions";

async function backfill() {
  const rows = await queryTikTok(
    `SELECT s.id, s.title, s.status, s.context
     FROM ${SESSION_TABLE} s
     INNER JOIN tiktok_campaign tc ON tc.session_id = s.id AND tc.status <> 'deleted'
     WHERE s.status = 'draft'`
  );

  let fixed = 0;
  for (const row of rows || []) {
    let context = {};
    try {
      context =
        typeof row.context === "string"
          ? JSON.parse(row.context)
          : row.context || {};
    } catch {
      context = {};
    }

    const shouldPublish =
      context.published === true ||
      context.workflowState === "published" ||
      !!context.campaignId;

    if (!shouldPublish) continue;

    const campaignId = context.campaignId || null;
    const newContext = {
      ...context,
      published: true,
      workflowState: "published",
      ...(campaignId ? { campaignId } : {}),
    };

    await queryTikTok(
      `UPDATE ${SESSION_TABLE}
       SET status = 'published', context = ?, updated_at = NOW()
       WHERE id = ?`,
      [JSON.stringify(newContext), row.id]
    );
    console.log(`已修复: ${row.id} (${row.title || "无标题"})`);
    fixed += 1;
  }

  console.log(`\n完成，共修复 ${fixed} 条会话。请刷新页面查看「已发布 Campaign」列表。`);
}

backfill().catch((e) => {
  console.error(e);
  process.exit(1);
});
