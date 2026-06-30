/**
 * 从指定 session 中移除误写入的其他 Campaign 对话块（如 Nexbie 混入 VAST）。
 *
 * 使用：
 *   node scripts/clean-session-foreign-messages.js --dry-run
 *   node scripts/clean-session-foreign-messages.js --session <uuid>
 *   node scripts/clean-session-foreign-messages.js --session <uuid> --trim-before-created
 *   node scripts/clean-session-foreign-messages.js --session <uuid> --from-marker nexbie.com
 */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import { queryTikTok } from "../lib/db/mysql-tiktok.js";
import { updateCampaignSession } from "../lib/db/campaign-session-dao.js";
import {
  normalizeSessionMessagesForStorage,
  trimMessagesBeforeSessionCreated,
  stripForeignCampaignBlocks,
  ownMarkersFromSessionTitle,
  findForeignBlockStart,
} from "../lib/chat/session-messages.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
dotenv.config({ path: path.join(projectRoot, ".env") });
dotenv.config({ path: path.join(projectRoot, ".env.local") });

const dryRun = process.argv.includes("--dry-run");
const trimBeforeCreated = process.argv.includes("--trim-before-created");
const sessionArgIdx = process.argv.indexOf("--session");
const sessionId =
  sessionArgIdx >= 0
    ? process.argv[sessionArgIdx + 1]
    : "ff20e93e-73bd-412d-b974-427566e33bf7";
const fromMarkerIdx = process.argv.indexOf("--from-marker");
const foreignMarker = fromMarkerIdx >= 0 ? process.argv[fromMarkerIdx + 1] : null;

const scriptPath = fileURLToPath(import.meta.url);

async function main() {
  const rows = await queryTikTok(
    `SELECT id, title, messages, created_at FROM tiktok_campaign_sessions WHERE id = ?`,
    [sessionId]
  );
  const row = rows?.[0];
  if (!row) {
    console.error("[CleanForeignMessages] 会话不存在:", sessionId);
    process.exit(1);
  }

  const before =
    typeof row.messages === "string" ? JSON.parse(row.messages) : row.messages;
  if (!Array.isArray(before)) {
    console.error("[CleanForeignMessages] messages 不是数组");
    process.exit(1);
  }

  let kept = before;
  let modeLabel = "none";

  if (trimBeforeCreated) {
    const createdAt = row.created_at
      ? new Date(row.created_at).toISOString()
      : null;
    kept = trimMessagesBeforeSessionCreated(before, createdAt);
    modeLabel = `trim-before-created (${createdAt || "unknown"})`;
  } else if (foreignMarker) {
    const ownMarkers = ownMarkersFromSessionTitle(row.title);
    const start = findForeignBlockStart(before, {
      ownMarkers,
      foreignMarker,
    });
    if (start < 0) {
      console.log(
        `[CleanForeignMessages] ${row.title || sessionId}：未发现含「${foreignMarker}」的误入块，无需清理。`
      );
      return;
    }
    kept = before.slice(0, start);
    modeLabel = `foreign-marker (${foreignMarker})`;
  } else {
    kept = stripForeignCampaignBlocks(before, row.title || "");
    modeLabel = `strip-by-title (${row.title || sessionId})`;
  }

  const normalized = normalizeSessionMessagesForStorage(kept);
  const removed = before.length - normalized.length;

  if (removed <= 0) {
    console.log(
      `[CleanForeignMessages] ${row.title || sessionId}：${modeLabel} 无需清理。`
    );
    return;
  }

  console.log(`[CleanForeignMessages] ${row.title || sessionId} [${modeLabel}]`);
  console.log(`  原 ${before.length} 条 → 保留 ${normalized.length} 条（删除 ${removed} 条）`);
  console.log(
    `  首条保留: ${String(normalized[normalized.length - 1]?.content || normalized[0]?.content || "").slice(0, 80).replace(/\n/g, " ")}`
  );

  if (dryRun) {
    console.log("[CleanForeignMessages] dry-run，未写入。");
    return;
  }

  const result = await updateCampaignSession(sessionId, { messages: normalized });
  if (!result.success) {
    console.error("[CleanForeignMessages] 写入失败:", result.message);
    process.exit(1);
  }
  console.log("[CleanForeignMessages] 已写入。");
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  main().catch((err) => {
    console.error("[CleanForeignMessages] 异常:", err);
    process.exit(1);
  });
}
