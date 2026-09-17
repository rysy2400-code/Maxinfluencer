/**
 * 为已发出的旧 Bin 特殊请求消息补写红人邮件附件标记。
 *
 * 与 backfill-special-request-bin-message-images.mjs 的区别：那个只处理图片，
 * 本脚本处理全部可展示附件（图片 / 视频 / PDF / Office / 未知二进制），
 * 并会过滤转发邮件本体、退信、S/MIME 签名、winmail.dat。
 *
 * 匹配逻辑：
 * - tiktok_advertiser_agent_event.event_type = creator_replied_special_request
 * - tiktok_campaign.status = running
 * - 按 payload.sourceEventId 读取收件附件，追加到 session.messages 里对应的 Bin 消息
 *
 * 用法：
 *   node scripts/backfill-special-request-bin-message-attachments.mjs --handle pedrohdarico --dry-run
 *   node scripts/backfill-special-request-bin-message-attachments.mjs --handle pedrohdarico --apply
 *
 * 参数：
 *   --handle <handle>  只处理指定红人（username / @handle，可多个，逗号分隔）；缺省处理全部
 *   --dry-run          仅预览，不写库（默认行为）
 *   --apply            真正写库
 */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import { queryTikTok } from "../lib/db/mysql-tiktok.js";
import {
  getCampaignSessionById,
  updateCampaignSession,
} from "../lib/db/campaign-session-dao.js";
import { listInboundAttachmentsByEmailEventId } from "../lib/db/influencer-inbound-attachments-dao.js";
import {
  appendMissingInboundAttachmentMarkers,
  selectDisplayableInboundAttachments,
} from "../lib/influencer/inbound-attachment-urls.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
dotenv.config({ path: path.join(projectRoot, ".env") });
dotenv.config({ path: path.join(projectRoot, ".env.local") });

const LOG = "[backfill-special-request-attachments]";
const argv = process.argv.slice(2);
const apply = argv.includes("--apply");
const dryRun = !apply || argv.includes("--dry-run");
const handleFilter = (() => {
  const idx = argv.indexOf("--handle");
  if (idx < 0) return [];
  return String(argv[idx + 1] || "")
    .split(",")
    .map((s) => s.trim().replace(/^@/, "").toLowerCase())
    .filter(Boolean);
})();

function parseJson(value) {
  if (value == null) return null;
  if (typeof value === "object") return value;
  if (typeof value !== "string") return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function isSpecialRequestBinMessage(msg) {
  if (!msg || msg.role !== "assistant") return false;
  const content = String(msg.content || "");
  return (
    content.includes("【特殊请求 · 待您决策】") ||
    content.includes("【特殊请求已达成一致】") ||
    content.includes("【特殊请求 · 请补充交付要求】")
  );
}

/** 用 creatorMessage / note 片段反查那条 Bin 消息。 */
function findMatchingMessageIndex(messages, { creatorMessage, note }) {
  if (!Array.isArray(messages) || !messages.length) return -1;

  const creator = String(creatorMessage || "").trim();
  const noteText = String(note || "").trim();

  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (!isSpecialRequestBinMessage(msg)) continue;
    const content = String(msg.content || "");

    if (creator && content.includes(`红人回复：${creator}`)) return i;

    if (noteText.length >= 12) {
      if (content.includes(`执行侧摘要：${noteText}`)) return i;
      const snippet = noteText.slice(0, Math.min(48, noteText.length));
      if (snippet.length >= 12 && content.includes(snippet)) return i;
    }
  }
  return -1;
}

async function fetchTargetEvents() {
  const rows = await queryTikTok(
    `
    SELECT
      e.id AS event_id,
      e.campaign_id,
      e.influencer_id,
      e.payload,
      e.created_at,
      c.session_id,
      c.status AS campaign_status
    FROM tiktok_advertiser_agent_event e
    INNER JOIN tiktok_campaign c ON c.id = e.campaign_id
    WHERE e.event_type = 'creator_replied_special_request'
      AND e.status = 'succeeded'
      AND c.status = 'running'
      AND c.session_id IS NOT NULL
      AND TRIM(c.session_id) <> ''
    ORDER BY e.id ASC
  `,
    []
  );
  return rows || [];
}

async function main() {
  const events = await fetchTargetEvents();
  console.log(`${LOG} 目标事件数（running campaign / succeeded）: ${events.length}`);
  if (handleFilter.length) {
    console.log(`${LOG} handle 过滤: ${handleFilter.join(", ")}`);
  }
  console.log(
    `${LOG} ${dryRun ? "DRY RUN —— 不会写库（加 --apply 才写入）" : "APPLY —— 会写库"}`
  );

  const sessionCache = new Map();
  let updatedSessions = 0;
  let updatedMessages = 0;
  let skippedNoSource = 0;
  let skippedNoAttachments = 0;
  let skippedNoMatch = 0;
  let skippedAlready = 0;
  let skippedFiltered = 0;

  for (const row of events) {
    const payload = parseJson(row.payload) || {};

    if (handleFilter.length) {
      const handle = String(payload.tiktokUsername || payload.influencerId || "")
        .replace(/^@/, "")
        .toLowerCase();
      if (!handleFilter.includes(handle)) {
        skippedFiltered++;
        continue;
      }
    }

    const sourceEventId =
      payload.sourceEventId != null ? Number(payload.sourceEventId) : null;
    if (!sourceEventId || Number.isNaN(sourceEventId)) {
      skippedNoSource++;
      console.log(`  SKIP event ${row.event_id}: 无 sourceEventId`);
      continue;
    }

    const inboundAttachments = await listInboundAttachmentsByEmailEventId(sourceEventId);
    const displayable = selectDisplayableInboundAttachments(inboundAttachments);
    if (!displayable.length) {
      skippedNoAttachments++;
      console.log(
        `  SKIP event ${row.event_id}: sourceEventId=${sourceEventId} 无可展示附件（原始 ${inboundAttachments.length} 个）`
      );
      continue;
    }

    const sessionId = row.session_id;
    let session = sessionCache.get(sessionId);
    if (!session) {
      const loaded = await getCampaignSessionById(sessionId);
      if (!loaded) {
        console.log(`  SKIP event ${row.event_id}: session ${sessionId} 不存在`);
        continue;
      }
      session = {
        ...loaded,
        messages: Array.isArray(loaded.messages) ? [...loaded.messages] : [],
        dirty: false,
      };
      sessionCache.set(sessionId, session);
    }

    const msgIndex = findMatchingMessageIndex(session.messages, {
      creatorMessage: payload.creatorMessage,
      note: payload.note,
    });
    if (msgIndex < 0) {
      skippedNoMatch++;
      console.log(
        `  SKIP event ${row.event_id}: campaign=${row.campaign_id} 未找到匹配的 Bin 特殊请求消息`
      );
      continue;
    }

    const oldContent = String(session.messages[msgIndex].content || "");
    const newContent = appendMissingInboundAttachmentMarkers(
      oldContent,
      inboundAttachments
    );
    if (newContent === oldContent) {
      skippedAlready++;
      continue;
    }

    console.log(
      `  PATCH event ${row.event_id} campaign=${row.campaign_id} session=${sessionId} msgIndex=${msgIndex} attachments=${displayable
        .map((a) => `${a.inboundAttachmentId}:${a.contentType}`)
        .join(", ")}`
    );

    session.messages[msgIndex] = {
      ...session.messages[msgIndex],
      content: newContent,
    };
    session.dirty = true;
    updatedMessages++;
  }

  for (const [sessionId, cached] of sessionCache.entries()) {
    if (!cached.dirty) continue;
    if (dryRun) {
      updatedSessions++;
      console.log(`  WOULD SAVE session ${sessionId}`);
      continue;
    }
    const result = await updateCampaignSession(sessionId, {
      messages: cached.messages,
    });
    if (!result.success) {
      console.error(`  FAIL session ${sessionId}: ${result.message}`);
      continue;
    }
    updatedSessions++;
    console.log(`  SAVED session ${sessionId}`);
  }

  console.log(`\n${LOG} 完成`);
  console.log(`  sessions updated: ${updatedSessions}`);
  console.log(`  messages patched: ${updatedMessages}`);
  console.log(`  skipped (handle 不匹配): ${skippedFiltered}`);
  console.log(`  skipped (无 sourceEventId): ${skippedNoSource}`);
  console.log(`  skipped (无可展示附件): ${skippedNoAttachments}`);
  console.log(`  skipped (未匹配到消息): ${skippedNoMatch}`);
  console.log(`  skipped (已含附件标记): ${skippedAlready}`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(`${LOG} 失败:`, err);
    process.exit(1);
  });
