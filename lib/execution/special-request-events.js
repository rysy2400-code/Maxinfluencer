/**
 * 特殊请求：仅通过 influencer / advertiser agent event 表驱动，不依赖 influencer_special_requests。
 */
import { queryTikTok } from "../db/mysql-tiktok.js";
import { enqueueInfluencerAgentEvent } from "../db/influencer-agent-event-dao.js";
import { getExecutionPlatformInfluencerId } from "../db/campaign-dao.js";
import {
  MAX_ATTACHMENTS_PER_MESSAGE,
  normalizeAttachmentContentType,
} from "../influencer/attachment-file-types.js";
import { readSessionImportFile } from "../influencer/session-import-storage.js";
import { insertOutboundAttachment } from "../db/influencer-outbound-attachments-dao.js";

export function generateSpecialRequestId() {
  return `SR-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function parsePayload(raw) {
  if (raw == null) return {};
  if (typeof raw === "object") return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function payloadSpecialRequestId(payload) {
  const p = parsePayload(payload);
  return p.specialRequestId || p.requestId || null;
}

/**
 * @param {{ campaignId: string, influencerHandle: string, requestType: string, brandMessage: string, deadline?: string|null }} opts
 */
export async function enqueueAskInfluencerSpecialRequest({
  campaignId,
  influencerHandle,
  requestType,
  brandMessage,
  deadline = null,
  attachments = [],
}) {
  const handle = String(influencerHandle || "")
    .replace(/^@/, "")
    .trim();
  if (!campaignId || !handle) {
    throw new Error("缺少 campaignId 或红人 handle");
  }
  if (!brandMessage || !String(brandMessage).trim()) {
    throw new Error("缺少 brandMessage / requestDetail");
  }

  const platformInfluencerId = await getExecutionPlatformInfluencerId(
    campaignId,
    handle
  );
  if (!platformInfluencerId) {
    throw new Error(
      `未在本 Campaign 执行表中找到红人 @${handle}，请确认 handle 正确且该红人已进入执行队列`
    );
  }

  const specialRequestId = generateSpecialRequestId();
  const normalizedAttachments = Array.isArray(attachments) && attachments.length
    ? normalizeSpecialRequestAttachments(attachments)
    : [];
  const persistedAttachments = await persistSpecialRequestAttachments(
    normalizedAttachments,
    specialRequestId
  );
  const payload = {
    campaignId,
    influencerId: handle,
    platformInfluencerId,
    specialRequestId,
    specialRequestStatus: "pending_creator",
    requestDirection: "brand_to_creator",
    brandMessage: String(brandMessage).trim(),
    requestType: requestType || "other",
    ...(deadline ? { deadline } : {}),
    ...(persistedAttachments.length ? { attachments: persistedAttachments } : {}),
  };

  const eventId = await enqueueInfluencerAgentEvent({
    influencerId: platformInfluencerId,
    campaignId,
    eventType: "ask_influencer_special_request",
    payload,
  });

  return { specialRequestId, eventId, platformInfluencerId, handle, payload };
}

/**
 * 把待发附件写进 tiktok_influencer_outbound_attachments，payload 里只留 id。
 *
 * 为什么必须落库：上传发生在 Web 机器（附件写在 Web 的 data/session-imports），
 * 而真正发信的 influencer agent worker 跑在另一台机器上，读不到 Web 的本地文件。
 * 只带 storageKey 的话 worker 会报「附件不存在或读取失败」，整条事件失败、邮件发不出去。
 *
 * 这里读不到文件会直接抛错（而不是让事件异步失败），这样广告主在聊天框里
 * 立刻看到「发送失败：附件不存在」，而不是以为已经发出去了。
 */
async function persistSpecialRequestAttachments(items, specialRequestId) {
  if (!items.length) return [];
  const out = [];
  for (let idx = 0; idx < items.length; idx++) {
    const att = items[idx];
    const outboundDedupeKey = `special:${specialRequestId}:${idx}`;
    const buffer = readSessionImportFile(att.storageKey);
    if (!buffer?.length) {
      throw new Error(
        `附件「${att.fileName}」在服务器上不存在或读取失败，请重新上传后再发送`
      );
    }
    const outboundAttachmentId = await insertOutboundAttachment({
      dedupeKey: outboundDedupeKey,
      filename: att.fileName,
      contentType: att.contentType,
      sizeBytes: buffer.length,
      content: buffer,
    });
    out.push({
      ...att,
      sizeBytes: buffer.length,
      outboundDedupeKey,
      ...(outboundAttachmentId ? { outboundAttachmentId } : {}),
    });
  }
  return out;
}

/**
 * 只保留带 storageKey + fileName 的附件元数据（PDF / Word / PPT / 图片资料），
 * 按 storageKey 去重并限制单封最多 MAX_ATTACHMENTS_PER_MESSAGE 个。
 */
function normalizeSpecialRequestAttachments(rawAttachments) {
  if (!Array.isArray(rawAttachments)) return [];
  const seen = new Set();
  const items = [];
  for (const raw of rawAttachments) {
    if (items.length >= MAX_ATTACHMENTS_PER_MESSAGE) break;
    const storageKey = String(raw?.storageKey || "").trim();
    const fileName = String(raw?.fileName || "").trim();
    if (!storageKey || !fileName) continue;
    if (seen.has(storageKey)) continue;
    seen.add(storageKey);
    items.push({
      fileName,
      storageKey,
      contentType: normalizeAttachmentContentType(fileName, raw?.contentType),
      sizeBytes:
        typeof raw?.sizeBytes === "number" && Number.isFinite(raw.sizeBytes)
          ? raw.sizeBytes
          : null,
    });
  }
  return items;
}

/**
 * 按 specialRequestId / requestId 查询反馈（advertiser event 优先，其次 ask event 状态）。
 * @param {string} requestId
 */
export async function findSpecialRequestFeedback(requestId) {
  const id = String(requestId || "").trim();
  if (!id) return null;

  const replyRows = await queryTikTok(
    `
    SELECT id, campaign_id, influencer_id, event_type, status, payload, created_at
    FROM tiktok_advertiser_agent_event
    WHERE event_type = 'creator_replied_special_request'
      AND (
        JSON_UNQUOTE(JSON_EXTRACT(payload, '$.specialRequestId')) = ?
        OR JSON_UNQUOTE(JSON_EXTRACT(payload, '$.requestId')) = ?
      )
    ORDER BY id DESC
    LIMIT 1
  `,
    [id, id]
  );

  if (replyRows?.length) {
    const row = replyRows[0];
    const p = parsePayload(row.payload);
    const specialRequestStatus =
      p.specialRequestStatus || p.status || "pending_brand";
    return {
      requestId: id,
      specialRequestId: id,
      status: "replied",
      specialRequestStatus,
      influencerReply: p.creatorMessage || p.influencerReply || null,
      note: p.note || null,
      campaignId: p.campaignId || row.campaign_id || null,
      influencerId: p.influencerId || row.influencer_id || null,
      syncedToAdvertiser: row.status === "succeeded",
      repliedAt: row.created_at,
      sourceAdvertiserEventId: row.id,
    };
  }

  const askRows = await queryTikTok(
    `
    SELECT id, campaign_id, influencer_id, status, payload, error_message, created_at
    FROM tiktok_influencer_agent_event
    WHERE event_type = 'ask_influencer_special_request'
      AND (
        JSON_UNQUOTE(JSON_EXTRACT(payload, '$.specialRequestId')) = ?
        OR JSON_UNQUOTE(JSON_EXTRACT(payload, '$.requestId')) = ?
      )
    ORDER BY id DESC
    LIMIT 1
  `,
    [id, id]
  );

  if (!askRows?.length) {
    return {
      requestId: id,
      specialRequestId: id,
      status: "unknown",
      specialRequestStatus: null,
      influencerReply: null,
      syncedToAdvertiser: false,
    };
  }

  const ask = askRows[0];
  const askPayload = parsePayload(ask.payload);
  if (ask.status === "failed") {
    return {
      requestId: id,
      specialRequestId: id,
      status: "failed",
      specialRequestStatus: "failed",
      influencerReply: null,
      errorMessage: ask.error_message || "向红人发送询问失败",
      campaignId: askPayload.campaignId || ask.campaign_id || null,
      influencerId: askPayload.influencerId || ask.influencer_id || null,
      syncedToAdvertiser: false,
      sourceInfluencerEventId: ask.id,
    };
  }

  if (ask.status === "succeeded") {
    return {
      requestId: id,
      specialRequestId: id,
      status: "pending",
      specialRequestStatus: "pending_creator",
      influencerReply: null,
      campaignId: askPayload.campaignId || ask.campaign_id || null,
      influencerId: askPayload.influencerId || ask.influencer_id || null,
      syncedToAdvertiser: false,
      sourceInfluencerEventId: ask.id,
      sentAt: ask.created_at,
    };
  }

  return {
    requestId: id,
    specialRequestId: id,
    status: "pending",
    specialRequestStatus: ask.status === "processing" ? "processing" : "pending_creator",
    influencerReply: null,
    campaignId: askPayload.campaignId || ask.campaign_id || null,
    influencerId: askPayload.influencerId || ask.influencer_id || null,
    syncedToAdvertiser: false,
    sourceInfluencerEventId: ask.id,
  };
}
