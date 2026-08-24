/**
 * Worker：消费 tiktok_advertiser_agent_event，作为 CampaignExecutionAgent 统一更新 campaign / execution 表。
 *
 * 职责（MVP）：
 * - 处理 InfluencerAgent 发来的「execution_update_suggested」类事件
 *   - 根据 payload 中的 campaignId / influencerId / newStage / flatFeeUSD / videoLink / shippingInfo
 *     更新 tiktok_campaign_execution 对应行，并在 last_event 中记录来源。
 *
 * 使用方式（示例）：
 *   node scripts/process-campaign-agent-events.js
 */

import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import { queryTikTok } from "../lib/db/mysql-tiktok.js";
import {
  SQL_EXECUTION_CREATOR_MATCH,
  paramsExecutionCreatorMatch,
} from "../lib/db/campaign-execution-keys.js";
import { appendBinMessageToSession } from "../lib/db/campaign-session-dao.js";
import { logConversationMessage } from "../lib/db/influencer-conversation-dao.js";
import {
  buildCampaignUpdateMessageId,
  buildTraceIdFromInboundMessageId,
} from "../lib/utils/timeline-ids.js";
import { resolveInfluencerAgentUpdate } from "../lib/execution/stage-transition.js";
import {
  isCompleteShippingInfo,
  normalizeShippingInfo,
} from "../lib/execution/shipping-info.js";
import { listInboundAttachmentsByEmailEventId } from "../lib/db/influencer-inbound-attachments-dao.js";
import { buildInboundImageMarkers } from "../lib/influencer/inbound-attachment-urls.js";
import {
  formatExecInfluencerMention,
  isPlatformCreatorId,
  resolveTiktokUsernameForExecution,
} from "../lib/execution/exec-influencer-mention.js";

function parseJsonOrObject(value) {
  if (value == null) return null;
  if (typeof value === "object") return value;
  if (typeof value !== "string") return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
dotenv.config({ path: path.join(projectRoot, ".env") });
dotenv.config({ path: path.join(projectRoot, ".env.local") });

/** 邮件 Agent 建议写入的合法 stage（不含已废弃的 failed / sample_sent） */
const ALLOWED_EXECUTION_STAGES = new Set([
  "pending_quote",
  "quote_submitted",
  "pending_shipping_address",
  "pending_sample",
  "pending_script",
  "script_review",
  "video_review",
  "pending_video",
  "published",
  "quote_rejected",
]);

function normalizeCurrencyCode(v, fallback = "USD") {
  const s = String(v || "")
    .trim()
    .toUpperCase()
    .slice(0, 8);
  return s || fallback;
}

function parseQuoteNegotiationColumn(raw) {
  const o = parseJsonOrObject(raw);
  if (Array.isArray(o)) return o.filter((x) => x && typeof x === "object");
  return [];
}

async function fetchPendingCampaignAgentEvents(limit = 20) {
  const n = Math.min(50, Math.max(1, Number(limit) || 20));
  const rows = await queryTikTok(
    `
    SELECT *
    FROM tiktok_advertiser_agent_event
    WHERE status = 'pending'
    ORDER BY created_at ASC
    LIMIT ${n}
  `,
    []
  );
  return rows || [];
}

async function markCampaignAgentEventStatus(id, status, errorMessage = null) {
  await queryTikTok(
    `
    UPDATE tiktok_advertiser_agent_event
    SET status = ?, error_message = ?, updated_at = NOW()
    WHERE id = ?
  `,
    [status, errorMessage, id]
  );
}

async function applyExecutionUpdateSuggested(eventRow, payload) {
  const campaignId = payload.campaignId || eventRow.campaign_id;
  const influencerId = payload.influencerId || eventRow.influencer_id;
  const requestedStage = payload.newStage;

  if (!campaignId || !influencerId || !requestedStage) {
    throw new Error(
      "execution_update_suggested 缺少必要字段：campaignId / influencerId / newStage"
    );
  }

  if (!ALLOWED_EXECUTION_STAGES.has(requestedStage)) {
    throw new Error(
      `无效的 newStage「${requestedStage}」。允许值：${[...ALLOWED_EXECUTION_STAGES].join(
        ", "
      )}。注意：quote_rejected 仅表示「红人已报价后，品牌方拒绝该报价」；不要使用已废弃的 failed。`
    );
  }

  let flatFee =
    typeof payload.flatFeeUSD === "number"
      ? payload.flatFeeUSD
      : payload.flatFeeUSD && !Number.isNaN(Number(payload.flatFeeUSD))
      ? Number(payload.flatFeeUSD)
      : null;

  let videoLink =
    typeof payload.videoLink === "string" && payload.videoLink.trim()
      ? payload.videoLink.trim()
      : null;

  let draftLink =
    typeof payload.draftLink === "string" && payload.draftLink.trim()
      ? payload.draftLink.trim()
      : null;

  let shippingInfo =
    payload.shippingInfo && typeof payload.shippingInfo === "object"
      ? normalizeShippingInfo(payload.shippingInfo)
      : null;

  const emailEvent = payload.emailEvent || {};

  const execRows = await queryTikTok(
    `
    SELECT stage, flat_fee, currency, quote_negotiation, quote_origin, last_event
    FROM tiktok_campaign_execution
    WHERE campaign_id = ? AND ${SQL_EXECUTION_CREATOR_MATCH}
  `,
    [campaignId, ...paramsExecutionCreatorMatch(influencerId)]
  );
  if (!execRows || !execRows[0]) {
    throw new Error(`未找到执行行：${campaignId} / ${influencerId}`);
  }
  const cur = execRows[0];
  const currentStage = cur.stage || "pending_quote";

  const resolved = resolveInfluencerAgentUpdate({
    currentStage,
    requestedStage,
    lastEventRaw: cur.last_event,
    payload,
  });

  let { effectiveStage, skippedStageReason, draftLinkOnly } = resolved;

  if (skippedStageReason && !draftLinkOnly) {
    console.warn(
      `[ProcessCampaignAgentEvents] stage 变更被拦截 (${campaignId}/${influencerId}): ${currentStage} → ${requestedStage}. ${skippedStageReason}`
    );
  } else if (draftLinkOnly) {
    console.log(
      `[ProcessCampaignAgentEvents] pending_sample 提前交稿 (${campaignId}/${influencerId}): 仅保存 draftLink，stage 保持 ${currentStage}`
    );
  }

  let nextCurrency = normalizeCurrencyCode(cur.currency, "USD");
  let nextQuoteOrigin = cur.quote_origin || null;
  let negotiation = parseQuoteNegotiationColumn(cur.quote_negotiation);
  let mergedLastEvent = parseJsonOrObject(cur.last_event) || {};

  if (resolved.allowFlatFeeUpdate && flatFee != null && Number.isFinite(Number(flatFee))) {
    const role =
      payload.quoteRole === "advertiser" || payload.fromAdvertiser === true
        ? "advertiser"
        : "influencer";
    if (role === "influencer") nextQuoteOrigin = "creator_quote";
    nextCurrency = normalizeCurrencyCode(payload.currency || cur.currency, nextCurrency);
    negotiation = [
      ...negotiation,
      {
        role,
        amount: Number(flatFee),
        currency: nextCurrency,
        reason:
          typeof payload.quoteReason === "string" && payload.quoteReason.trim()
            ? payload.quoteReason.trim()
            : typeof payload.note === "string" && payload.note.trim()
              ? payload.note.trim()
              : null,
        at: new Date().toISOString(),
        source: "advertiser_agent_event",
        sourceEventId: eventRow.id,
      },
    ];
  } else if (flatFee != null) {
    flatFee = null;
  }

  if (!resolved.allowShippingInfoUpdate) {
    shippingInfo = null;
  }
  if (
    currentStage === "pending_shipping_address" &&
    requestedStage === "pending_sample" &&
    !isCompleteShippingInfo(shippingInfo)
  ) {
    shippingInfo = null;
    effectiveStage = currentStage;
    skippedStageReason = "寄样信息不完整，继续等待红人补充/确认。";
  }

  if (resolved.allowDraftLinkUpdate) {
    if (!draftLink && videoLink) {
      draftLink = videoLink;
      videoLink = null;
    }
    if (draftLink) {
      const savedAt = new Date().toISOString();
      mergedLastEvent = resolved.draftLinkOnly
        ? {
            ...mergedLastEvent,
            draftLink,
            draftLinkSavedAt: savedAt,
          }
        : {
            ...mergedLastEvent,
            draftLink,
            draftSubmittedAt: savedAt,
          };
    }
  } else {
    draftLink = null;
  }

  if (!resolved.allowVideoLinkUpdate) {
    videoLink = null;
  }

  // —— 结构化交付时间线（脚本 / 视频草稿 / 发布链接），存 last_event.deliverablesTimeline ——
  const savedAtIso = new Date().toISOString();
  let deliverablesTimeline = Array.isArray(mergedLastEvent.deliverablesTimeline)
    ? mergedLastEvent.deliverablesTimeline
    : [];
  if (!Array.isArray(deliverablesTimeline)) deliverablesTimeline = [];

  const deliverableSubmission =
    payload.deliverable &&
    (payload.deliverable.kind === "script" ||
      payload.deliverable.kind === "video_draft");
  if (resolved.allowDraftLinkUpdate && (draftLink || deliverableSubmission)) {
    const hasScriptApproved = Boolean(
      mergedLastEvent.scriptApprovedAt ||
        deliverablesTimeline.some(
          (e) => e?.kind === "script" && e?.type === "approved"
        )
    );
    let kind = payload.deliverable?.kind;
    if (kind !== "script" && kind !== "video_draft") {
      kind = hasScriptApproved ? "video_draft" : "script";
    }
    const effectiveLink = draftLink || payload.deliverable?.link || null;
    const eventAttachments = await listInboundAttachmentsByEmailEventId(
      emailEvent.id
    ).catch(() => []);
    const wantedFilename = payload.deliverable?.attachmentFilename;
    let attachmentMeta = null;
    if (wantedFilename && eventAttachments.length) {
      attachmentMeta =
        eventAttachments.find((a) => a.filename === wantedFilename) || null;
    } else if (!wantedFilename && eventAttachments.length === 1) {
      attachmentMeta = eventAttachments[0];
    }
    deliverablesTimeline = [
      ...deliverablesTimeline,
      {
        kind: kind === "published" ? "video_draft" : kind,
        role: "influencer",
        type: "submitted",
        content: payload.deliverable?.content || null,
        link: effectiveLink,
        attachment: attachmentMeta
          ? {
              inboundAttachmentId: attachmentMeta.inboundAttachmentId,
              filename: attachmentMeta.filename,
              contentType: attachmentMeta.contentType,
            }
          : null,
        at: savedAtIso,
        source: "influencer_email",
        emailEventId: emailEvent.id || null,
      },
    ];
  }

  if (resolved.allowVideoLinkUpdate && videoLink) {
    if (videoLink) mergedLastEvent.videoLink = videoLink;
    if (payload.promoCode) mergedLastEvent.promoCode = payload.promoCode;
    deliverablesTimeline = [
      ...deliverablesTimeline,
      {
        kind: "published",
        role: "influencer",
        type: "published_link",
        link: videoLink,
        content: payload.promoCode ? `投流码: ${payload.promoCode}` : null,
        promoCode: payload.promoCode || null,
        at: savedAtIso,
        source: "influencer_email",
        emailEventId: emailEvent.id || null,
      },
    ];
  }

  if (deliverablesTimeline.length) {
    mergedLastEvent.deliverablesTimeline = deliverablesTimeline;
  }

  mergedLastEvent = {
    ...mergedLastEvent,
    campaignAgentDecision: {
      updatedAt: new Date().toISOString(),
      campaignId,
      influencerId,
      sourceEventId: eventRow.id,
      sourceEventType: eventRow.event_type,
      emailEvent: emailEvent || {},
      note: payload.note || "",
      requestedStage,
      effectiveStage,
      draftLinkOnly: draftLinkOnly || false,
      skippedStageReason: draftLinkOnly ? null : skippedStageReason || null,
      flatFeeUSD: flatFee,
      videoLink,
      draftLink,
      shippingInfo: shippingInfo || null,
    },
  };

  await queryTikTok(
    `
    UPDATE tiktok_campaign_execution
    SET stage = ?,
        flat_fee = COALESCE(?, flat_fee),
        currency = ?,
        quote_negotiation = ?,
        quote_origin = ?,
        video_link = COALESCE(?, video_link),
        shipping_info = COALESCE(?, shipping_info),
        last_event = ?
    WHERE campaign_id = ? AND ${SQL_EXECUTION_CREATOR_MATCH}
  `,
    [
      effectiveStage,
      flatFee,
      nextCurrency,
      JSON.stringify(negotiation),
      nextQuoteOrigin,
      videoLink,
      shippingInfo ? JSON.stringify(shippingInfo) : null,
      JSON.stringify(mergedLastEvent),
      campaignId,
      ...paramsExecutionCreatorMatch(influencerId),
    ]
  );
}

/**
 * 处理 creator_replied_special_request：红人回复特殊请求。
 * - 更新 tiktok_campaign_execution.last_event 记录结论（不自动改 flat_fee / stage）
 * - resolved / pending_brand 均追加 Bin 消息到广告主 session
 */
async function applyCreatorRepliedSpecialRequest(eventRow, payload) {
  const campaignId = payload.campaignId || eventRow.campaign_id;
  const influencerId = payload.influencerId || eventRow.influencer_id;
  const specialRequestId = payload.specialRequestId || null;
  const specialRequestStatus = payload.specialRequestStatus || "pending_brand";
  const creatorMessage = payload.creatorMessage || "";
  const note = payload.note || "";

  if (!campaignId || !influencerId) {
    throw new Error(
      "creator_replied_special_request 缺少 campaignId 或 influencerId"
    );
  }

  const summary = {
    type: "special_request_resolved",
    specialRequestId,
    specialRequestStatus,
    creatorMessage,
    note,
    resolvedAt: new Date().toISOString(),
    sourceEventId: eventRow.id,
  };

  await queryTikTok(
    `
    UPDATE tiktok_campaign_execution
    SET last_event = JSON_MERGE_PRESERVE(
          COALESCE(last_event, JSON_OBJECT()),
          JSON_OBJECT(
            'specialRequestResolved',
            ?
          )
        )
    WHERE campaign_id = ? AND ${SQL_EXECUTION_CREATOR_MATCH}
  `,
    [JSON.stringify(summary), campaignId, ...paramsExecutionCreatorMatch(influencerId)]
  );

  // 同步广告主聊天：红人同意或需品牌决策时均通知（不自动改 flat_fee）
  if (specialRequestStatus === "resolved" || specialRequestStatus === "pending_brand") {
    try {
      const rows = await queryTikTok(
        "SELECT session_id FROM tiktok_campaign WHERE id = ? LIMIT 1",
        [campaignId]
      );
      const sessionId = rows?.[0]?.session_id || null;
      if (sessionId) {
        let tiktokUsername =
          typeof payload.tiktokUsername === "string"
            ? payload.tiktokUsername.trim().replace(/^@/, "")
            : "";
        if (!tiktokUsername || isPlatformCreatorId(tiktokUsername)) {
          tiktokUsername =
            (await resolveTiktokUsernameForExecution(campaignId, influencerId)) ||
            (await resolveTiktokUsernameForExecution(campaignId, tiktokUsername)) ||
            "";
        }
        const handleHint = tiktokUsername
          ? formatExecInfluencerMention(tiktokUsername)
          : `@${influencerId}`;
        const sourceEmailEventId =
          payload.sourceEventId != null ? Number(payload.sourceEventId) : null;
        const inboundAttachments =
          sourceEmailEventId && !Number.isNaN(sourceEmailEventId)
            ? await listInboundAttachmentsByEmailEventId(sourceEmailEventId)
            : [];
        const attachmentMarkers = buildInboundImageMarkers(inboundAttachments);
        const content =
          payload.clarificationType === "delivery_requirement"
            ? `【特殊请求 · 请补充交付要求】\n\n红人 ${handleHint} 提供了多个交付档位，但当前 Campaign 信息不足以判断应采用哪一档。\n\n红人报价：${creatorMessage}\n\n请明确具体交付形式后，Bin 将据此更新红人有效报价。\n\n执行侧摘要：${note}${attachmentMarkers}`
            : specialRequestStatus === "resolved"
            ? `【特殊请求已达成一致】\n\n红人 ${handleHint} 已同意本轮特殊请求。\n\n红人回复：${creatorMessage}\n\n执行侧摘要：${note}\n\n（未自动修改报价/条数，如需调整请在本对话中确认后再操作。）${attachmentMarkers}`
            : `【特殊请求 · 待您决策】\n\n红人 ${handleHint} 已对本轮询问作出回复，需要您确认下一步。\n\n红人回复：${creatorMessage}\n\n执行侧摘要：${note}\n\n（未自动修改报价/条数；您可继续协商或在本对话中明确指示。）${attachmentMarkers}`;
        const result = await appendBinMessageToSession(sessionId, content);
        if (!result.success) {
          console.warn(
            "[ProcessCampaignAgentEvents] 追加 Bin 消息到 session 失败:",
            result.message
          );
        }
      }
    } catch (err) {
      console.error(
        "[ProcessCampaignAgentEvents] 通知品牌方（追加 session 消息）失败:",
        err?.message || err
      );
    }
  }
}

async function logCampaignUpdateTimelineEvent({
  influencerId,
  campaignId,
  advertiserAgentEventId,
  advertiserEventType,
  sourceInboundMessageId,
  status,
  errorMessage,
  payloadSummary,
}) {
  if (!influencerId) return;
  const traceId = sourceInboundMessageId
    ? buildTraceIdFromInboundMessageId(sourceInboundMessageId)
    : `trace:adv_event:${advertiserAgentEventId}`;

  await logConversationMessage({
    influencerId,
    campaignId: campaignId || null,
    direction: "bin",
    channel: "email",
    fromEmail: null,
    toEmail: null,
    subject: null,
    bodyText: `[campaign_update] ${advertiserEventType} ${status}${
      errorMessage ? `: ${errorMessage}` : ""
    }`,
    messageId: buildCampaignUpdateMessageId(advertiserAgentEventId),
    sourceType: "advertiser_agent_event",
    sourceEventTable: "tiktok_advertiser_agent_event",
    sourceEventId: advertiserAgentEventId,
    sentAt: new Date(),
    eventType: "campaign_update",
    eventTime: new Date(),
    actorType: "system",
    traceId,
    payload: {
      kind: "campaign_update",
      status,
      error: errorMessage ? { message: errorMessage } : null,
      advertiserAgentEvent: {
        id: advertiserAgentEventId,
        eventType: advertiserEventType,
      },
      campaignId: campaignId || null,
      influencerId,
      sourceInboundMessageId: sourceInboundMessageId || null,
      summary: payloadSummary || null,
    },
  });
}

async function processCampaignAgentEvent(eventRow) {
  await markCampaignAgentEventStatus(eventRow.id, "processing", null);

  const payload = parseJsonOrObject(eventRow.payload) || {};
  const type = eventRow.event_type || payload.type || "generic";

  // 当前版本只处理 InfluencerAgent 发来的「execution_update_suggested」类事件
  if (type === "execution_update_suggested") {
    try {
      await applyExecutionUpdateSuggested(eventRow, payload);
      await markCampaignAgentEventStatus(eventRow.id, "succeeded", null);
      await logCampaignUpdateTimelineEvent({
        influencerId: payload.influencerId || eventRow.influencer_id,
        campaignId: payload.campaignId || eventRow.campaign_id,
        advertiserAgentEventId: eventRow.id,
        advertiserEventType: type,
        sourceInboundMessageId: payload?.emailEvent?.messageId || payload?.sourceMessageId || null,
        status: "succeeded",
        errorMessage: null,
        payloadSummary: {
          requestedStage: payload.newStage || null,
          flatFeeUSD: payload.flatFeeUSD || null,
          videoLink: payload.videoLink || null,
        },
      });
    } catch (err) {
      const msg = err?.message || String(err);
      await markCampaignAgentEventStatus(eventRow.id, "failed", msg);
      await logCampaignUpdateTimelineEvent({
        influencerId: payload.influencerId || eventRow.influencer_id,
        campaignId: payload.campaignId || eventRow.campaign_id,
        advertiserAgentEventId: eventRow.id,
        advertiserEventType: type,
        sourceInboundMessageId: payload?.emailEvent?.messageId || payload?.sourceMessageId || null,
        status: "failed",
        errorMessage: msg,
        payloadSummary: null,
      });
    }
    return;
  }

  if (type === "creator_replied_special_request") {
    try {
      await applyCreatorRepliedSpecialRequest(eventRow, payload);
      await markCampaignAgentEventStatus(eventRow.id, "succeeded", null);
      await logCampaignUpdateTimelineEvent({
        influencerId: payload.influencerId || eventRow.influencer_id,
        campaignId: payload.campaignId || eventRow.campaign_id,
        advertiserAgentEventId: eventRow.id,
        advertiserEventType: type,
        sourceInboundMessageId: payload?.sourceMessageId || null,
        status: "succeeded",
        errorMessage: null,
        payloadSummary: {
          specialRequestId: payload.specialRequestId || null,
          specialRequestStatus: payload.specialRequestStatus || null,
        },
      });
    } catch (err) {
      const msg = err?.message || String(err);
      await markCampaignAgentEventStatus(eventRow.id, "failed", msg);
      await logCampaignUpdateTimelineEvent({
        influencerId: payload.influencerId || eventRow.influencer_id,
        campaignId: payload.campaignId || eventRow.campaign_id,
        advertiserAgentEventId: eventRow.id,
        advertiserEventType: type,
        sourceInboundMessageId: payload?.sourceMessageId || null,
        status: "failed",
        errorMessage: msg,
        payloadSummary: null,
      });
    }
    return;
  }

  // 其它类型暂时跳过，由后续扩展
  await markCampaignAgentEventStatus(
    eventRow.id,
    "skipped",
    `未识别的 event_type：${type}`
  );
}

async function main() {
  const events = await fetchPendingCampaignAgentEvents(20);
  if (!events.length) {
    console.log("[ProcessCampaignAgentEvents] 当前没有 pending 事件。");
    return;
  }

  console.log(
    `[ProcessCampaignAgentEvents] 准备处理 ${events.length} 条 pending 事件。`
  );

  for (const ev of events) {
    try {
      await processCampaignAgentEvent(ev);
    } catch (err) {
      console.error(
        "[ProcessCampaignAgentEvents] 处理事件时出现未捕获错误:",
        err
      );
      await markCampaignAgentEventStatus(
        ev.id,
        "failed",
        `未捕获错误: ${err?.message || String(err)}`
      );
    }
  }
}

main()
  .then(() => {
    console.log("[ProcessCampaignAgentEvents] 本次处理完成。");
    process.exit(0);
  })
  .catch((err) => {
    console.error("[ProcessCampaignAgentEvents] 运行出错:", err);
    process.exit(1);
  });
