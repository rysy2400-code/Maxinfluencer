/**
 * 为「进行中 campaign」里已发送的旧 Bin 特殊请求消息补写红人邮件图片标记 [IMAGE:...]。
 *
 * 匹配逻辑：
 * - tiktok_advertiser_agent_event.event_type = creator_replied_special_request
 * - tiktok_campaign.status = running
 * - 按 payload.sourceEventId 读取收件附件，追加到 session.messages 中对应的 Bin 助手消息
 *
 * 用法：
 *   node scripts/backfill-special-request-bin-message-images.mjs           # 执行
 *   node scripts/backfill-special-request-bin-message-images.mjs --dry-run # 仅预览
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
  appendMissingInboundImageMarkers,
  isImageAttachment,
} from "../lib/influencer/inbound-attachment-urls.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
dotenv.config({ path: path.join(projectRoot, ".env") });
dotenv.config({ path: path.join(projectRoot, ".env.local") });

const dryRun = process.argv.includes("--dry-run");

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
  return content.includes("【特殊请求 · 待您决策】") || content.includes("【特殊请求已达成一致】");
}

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
      e.status AS event_status,
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
  console.log(
    `[backfill-special-request-images] 目标事件数（running campaign / succeeded）: ${events.length}`
  );
  if (dryRun) console.log("[backfill-special-request-images] DRY RUN — 不会写入数据库");

  const sessionCache = new Map();
  let updatedSessions = 0;
  let updatedMessages = 0;
  let skippedNoSource = 0;
  let skippedNoImages = 0;
  let skippedNoMatch = 0;
  let skippedAlready = 0;

  for (const row of events) {
    const payload = parseJson(row.payload) || {};
    const sourceEventId =
      payload.sourceEventId != null ? Number(payload.sourceEventId) : null;
    if (!sourceEventId || Number.isNaN(sourceEventId)) {
      skippedNoSource++;
      console.log(`  SKIP event ${row.event_id}: 无 sourceEventId`);
      continue;
    }

    const inboundAttachments = await listInboundAttachmentsByEmailEventId(sourceEventId);
    const imageAttachments = inboundAttachments.filter((a) =>
      isImageAttachment(a.contentType)
    );
    if (!imageAttachments.length) {
      skippedNoImages++;
      console.log(`  SKIP event ${row.event_id}: sourceEventId=${sourceEventId} 无图片附件`);
      continue;
    }

    const sessionId = row.session_id;
    let session = sessionCache.get(sessionId);
    if (!session) {
      session = await getCampaignSessionById(sessionId);
      if (!session) {
        console.log(`  SKIP event ${row.event_id}: session ${sessionId} 不存在`);
        continue;
      }
      sessionCache.set(sessionId, {
        ...session,
        messages: Array.isArray(session.messages) ? [...session.messages] : [],
        dirty: false,
      });
    }

    const cached = sessionCache.get(sessionId);
    const msgIndex = findMatchingMessageIndex(cached.messages, {
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

    const oldContent = String(cached.messages[msgIndex].content || "");
    const newContent = appendMissingInboundImageMarkers(oldContent, inboundAttachments);
    if (newContent === oldContent) {
      skippedAlready++;
      continue;
    }

    console.log(
      `  PATCH event ${row.event_id} campaign=${row.campaign_id} session=${sessionId} msgIndex=${msgIndex} images=${imageAttachments.map((a) => a.inboundAttachmentId).join(",")}`
    );

    cached.messages[msgIndex] = {
      ...cached.messages[msgIndex],
      content: newContent,
    };
    cached.dirty = true;
    updatedMessages++;
  }

  for (const [sessionId, cached] of sessionCache.entries()) {
    if (!cached.dirty) continue;
    if (dryRun) {
      updatedSessions++;
      continue;
    }
    const result = await updateCampaignSession(sessionId, { messages: cached.messages });
    if (!result.success) {
      console.error(`  FAIL session ${sessionId}: ${result.message}`);
      continue;
    }
    updatedSessions++;
    console.log(`  SAVED session ${sessionId}`);
  }

  console.log("\n[backfill-special-request-images] 完成");
  console.log(`  sessions updated: ${updatedSessions}`);
  console.log(`  messages patched: ${updatedMessages}`);
  console.log(`  skipped (no sourceEventId): ${skippedNoSource}`);
  console.log(`  skipped (no image attachments): ${skippedNoImages}`);
  console.log(`  skipped (no matching message): ${skippedNoMatch}`);
  console.log(`  skipped (already has images): ${skippedAlready}`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("[backfill-special-request-images] 失败:", err);
    process.exit(1);
  });
