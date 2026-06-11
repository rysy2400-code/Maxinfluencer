/**
 * 按 createdAt 重排并剔除工作实况空占位，修复轮询追加 / slice(-50) 导致的乱序。
 *
 * 使用：
 *   node scripts/backfill-session-messages-order.js
 *   node scripts/backfill-session-messages-order.js --dry-run
 *   node scripts/backfill-session-messages-order.js --session <uuid>
 */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import { queryTikTok } from "../lib/db/mysql-tiktok.js";
import { updateCampaignSession } from "../lib/db/campaign-session-dao.js";
import {
  normalizeSessionMessagesForStorage,
  sessionMessageMergeKey,
} from "../lib/chat/session-messages.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
dotenv.config({ path: path.join(projectRoot, ".env") });
dotenv.config({ path: path.join(projectRoot, ".env.local") });

const dryRun = process.argv.includes("--dry-run");
const sessionArgIdx = process.argv.indexOf("--session");
const sessionFilter = sessionArgIdx >= 0 ? process.argv[sessionArgIdx + 1] : null;

function orderFingerprint(messages) {
  if (!Array.isArray(messages)) return "";
  return messages.map((m) => sessionMessageMergeKey(m)).join("\n");
}

async function loadSessionIds() {
  if (sessionFilter) return [sessionFilter];
  const rows = await queryTikTok(
    `
    SELECT id
    FROM tiktok_campaign_sessions
    WHERE JSON_LENGTH(messages) > 0
    ORDER BY updated_at DESC
  `
  );
  return (rows || []).map((r) => r.id);
}

async function main() {
  const ids = await loadSessionIds();
  if (!ids.length) {
    console.log("[BackfillMessageOrder] 无待处理会话。");
    return;
  }

  let updated = 0;
  for (const id of ids) {
    const rows = await queryTikTok(
      `SELECT id, title, messages FROM tiktok_campaign_sessions WHERE id = ?`,
      [id]
    );
    if (!rows?.[0]) continue;
    const row = rows[0];
    const before =
      typeof row.messages === "string" ? JSON.parse(row.messages) : row.messages;
    if (!Array.isArray(before) || before.length <= 1) continue;

    const normalized = normalizeSessionMessagesForStorage(before);
    if (
      orderFingerprint(before) === orderFingerprint(normalized) &&
      before.length === normalized.length
    ) {
      continue;
    }

    console.log(
      `[BackfillMessageOrder] ${id} (${row.title || "未命名"}) ${before.length} 条 → ${normalized.length} 条（排序+清理）`
    );
    if (!dryRun) {
      const result = await updateCampaignSession(id, { messages: normalized });
      if (!result.success) {
        console.error(`  失败: ${result.message}`);
        continue;
      }
    }
    updated += 1;
  }

  console.log(
    `[BackfillMessageOrder] 完成：${updated} 个会话${dryRun ? "（dry-run，未写入）" : "已写入"}。`
  );
}

main().catch((err) => {
  console.error("[BackfillMessageOrder] 异常:", err);
  process.exit(1);
});
