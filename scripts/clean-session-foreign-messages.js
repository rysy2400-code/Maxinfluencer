/**
 * 从指定 session 中移除误写入的其他 Campaign 对话块（如 Hailuo 混入 Ribbi）。
 *
 * 使用：
 *   node scripts/clean-session-foreign-messages.js --dry-run
 *   node scripts/clean-session-foreign-messages.js --session <uuid>
 *   node scripts/clean-session-foreign-messages.js --session <uuid> --from-marker ribbi.ai
 */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import { queryTikTok } from "../lib/db/mysql-tiktok.js";
import { updateCampaignSession } from "../lib/db/campaign-session-dao.js";
import {
  normalizeSessionMessagesForStorage,
  trimMessagesBeforeSessionCreated,
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
    : "90ae928a-7f47-47b5-a210-112e748b08ec";
const fromMarkerIdx = process.argv.indexOf("--from-marker");
const foreignMarker = (
  fromMarkerIdx >= 0 ? process.argv[fromMarkerIdx + 1] : "ribbi.ai"
).toLowerCase();

const HAILUO_OWN_MARKERS = ["hailuo", "hailuoai", "海螺"];
const HAILUO_SESSION_ID = "90ae928a-7f47-47b5-a210-112e748b08ec";
const VAST_SESSION_ID = "ff20e93e-73bd-412d-b974-427566e33bf7";

/**
 * 在「本 Campaign 对话」之后，找到第一条含 foreignMarker 的消息索引
 */
export function findForeignBlockStart(messages, { ownMarkers, foreignMarker: foreign }) {
  if (!Array.isArray(messages) || !foreign) return -1;
  const foreignLower = String(foreign).toLowerCase();
  const own = (ownMarkers || []).map((m) => String(m).toLowerCase());

  let lastOwnIndex = -1;
  for (let i = 0; i < messages.length; i++) {
    const c = String(messages[i]?.content || "").toLowerCase();
    if (own.some((m) => c.includes(m))) lastOwnIndex = i;
  }

  for (let i = Math.max(0, lastOwnIndex + 1); i < messages.length; i++) {
    const c = String(messages[i]?.content || "").toLowerCase();
    if (c.includes(foreignLower)) return i;
  }
  return -1;
}

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

  let kept;
  let removed;
  let modeLabel;

  if (trimBeforeCreated || sessionId === VAST_SESSION_ID) {
    const createdAt = row.created_at
      ? new Date(row.created_at).toISOString()
      : null;
    kept = trimMessagesBeforeSessionCreated(before, createdAt);
    removed = before.length - kept.length;
    modeLabel = `trim-before-created (${createdAt || "unknown"})`;
    if (removed <= 0) {
      console.log(
        `[CleanForeignMessages] ${row.title || sessionId}：按会话创建时间无需清理。`
      );
      return;
    }
  } else {
    const ownMarkers =
      sessionId === HAILUO_SESSION_ID ||
      String(row.title || "").toLowerCase().includes("hailuo")
        ? HAILUO_OWN_MARKERS
        : [];

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
    removed = before.length - start;
    modeLabel = `foreign-marker (${foreignMarker})`;
  }

  const normalized = normalizeSessionMessagesForStorage(kept);

  console.log(`[CleanForeignMessages] ${row.title || sessionId} [${modeLabel}]`);
  console.log(`  原 ${before.length} 条 → 保留 ${normalized.length} 条（删除 ${removed} 条）`);
  if (trimBeforeCreated || sessionId === VAST_SESSION_ID) {
    console.log(`  首条保留: ${String(normalized[0]?.content || "").slice(0, 80).replace(/\n/g, " ")}`);
  } else {
    console.log(`  删除起点: 第 ${before.length - removed + 1} 条`);
    console.log(`  首条删除: ${String(before[before.length - removed]?.content || "").slice(0, 80).replace(/\n/g, " ")}`);
  }

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
