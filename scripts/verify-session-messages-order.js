/**
 * 校验所有 tiktok_campaign_sessions.messages：
 * - 按 createdAt 严格升序（欢迎语例外）
 * - 无空 assistant 占位（工作实况脏数据）
 * - 统计可见聊天条数
 *
 * 使用：node scripts/verify-session-messages-order.js
 */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import { queryTikTok } from "../lib/db/mysql-tiktok.js";
import {
  isChatVisibleMessage,
  normalizeSessionMessagesForStorage,
  parseMessageTime,
} from "../lib/chat/session-messages.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
dotenv.config({ path: path.join(projectRoot, ".env") });
dotenv.config({ path: path.join(projectRoot, ".env.local") });

function checkChronological(messages) {
  let prev = null;
  for (let i = 0; i < messages.length; i++) {
    const t = parseMessageTime(messages[i]?.createdAt);
    if (t == null) continue;
    if (prev != null && t.getTime() < prev.getTime()) {
      return { ok: false, breakAt: i, prev: prev.toISOString(), cur: t.toISOString() };
    }
    prev = t;
  }
  return { ok: true };
}

async function main() {
  const rows = await queryTikTok(
    `
    SELECT id, title, messages, updated_at
    FROM tiktok_campaign_sessions
    WHERE JSON_LENGTH(messages) > 0
    ORDER BY updated_at DESC
  `
  );

  let total = 0;
  let orderOk = 0;
  let needsNormalize = 0;
  const problems = [];

  for (const row of rows || []) {
    total += 1;
    const raw =
      typeof row.messages === "string" ? JSON.parse(row.messages) : row.messages;
    if (!Array.isArray(raw) || raw.length === 0) continue;

    const normalized = normalizeSessionMessagesForStorage(raw);
    const chrono = checkChronological(normalized);
    const emptyAssistants = raw.filter(
      (m) =>
        m?.role === "assistant" &&
        !String(m?.content || "").trim() &&
        !(Array.isArray(m?.thinking?.steps) && m.thinking.steps.length > 0)
    ).length;
    const visibleCount = normalized.filter(isChatVisibleMessage).length;

    const fingerprintRaw = raw.map((m) => `${m.role}|${(m.content || "").slice(0, 40)}`).join("\n");
    const fingerprintNorm = normalized
      .map((m) => `${m.role}|${(m.content || "").slice(0, 40)}`)
      .join("\n");
    const dirty = fingerprintRaw !== fingerprintNorm || raw.length !== normalized.length;

    if (chrono.ok && !dirty && emptyAssistants === 0) {
      orderOk += 1;
    } else {
      if (dirty || emptyAssistants > 0) needsNormalize += 1;
      problems.push({
        id: row.id,
        title: row.title || "未命名",
        count: raw.length,
        normalizedCount: normalized.length,
        visibleCount,
        emptyAssistants,
        chronoOk: chrono.ok,
        chronoBreak: chrono.ok ? null : chrono,
        dirty,
      });
    }
  }

  console.log(`[VerifySessionMessages] 共 ${total} 个会话`);
  console.log(`[VerifySessionMessages] 完全正常: ${orderOk}`);
  console.log(`[VerifySessionMessages] 需修复: ${problems.length}`);

  if (problems.length > 0) {
    console.log("\n问题会话（最多 20 条）:");
    for (const p of problems.slice(0, 20)) {
      console.log(
        `  - ${p.title} (${p.id.slice(0, 8)}…) raw=${p.count} norm=${p.normalizedCount} visible=${p.visibleCount} emptyAsst=${p.emptyAssistants} chrono=${p.chronoOk} dirty=${p.dirty}`
      );
    }
    process.exitCode = 1;
  } else {
    console.log("[VerifySessionMessages] 全部通过 ✓");
  }
}

main().catch((err) => {
  console.error("[VerifySessionMessages] 异常:", err);
  process.exit(1);
});
