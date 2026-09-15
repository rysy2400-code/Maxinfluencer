/**
 * Worker：消费 tiktok_influencer_email_events 事件表，调用 LLM 做决策。
 *
 * 当前实现（按你的要求）：
 * - 不使用规则层，只把邮件 + 相关执行记录整体丢给 LLM，由 LLM 输出要更新哪些 campaign 的 stage / last_event。
 */

import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import { queryTikTok } from "../lib/db/mysql-tiktok.js";
import {
  SQL_EXECUTION_CREATOR_MATCH_E,
  paramsExecutionCreatorMatch,
} from "../lib/db/campaign-execution-keys.js";
import { callDeepSeekLLM } from "../lib/utils/llm-client.js";
import { sendMail } from "../lib/email/enterprise-mail-client.js";
import { logConversationMessage } from "../lib/db/influencer-conversation-dao.js";
import { normalizeCanonicalInfluencerId } from "../lib/influencer/influencer-id-resolver.js";
import { getInfluencerHandoverMode } from "../lib/db/influencer-handover-dao.js";
import { logDraftOutboundMessage } from "../lib/db/influencer-draft-dao.js";
import { influencerAgentBasePrompt } from "../lib/agents/influencer-agent-prompt.js";
import {
  loadConversationHistoryForInfluencer,
  stripBudgetFromCampaignInfo,
} from "../lib/agents/influencer-agent.js";
import {
  CONTENT_BRIEF_PRE_APPROVAL_PROMPT_RULES,
} from "../lib/execution/content-brief.js";
import {
  getInfluencerById,
  listInfluencerPlatformIdentities,
  markInfluencerDoNotContact,
  updateInfluencerBusinessProfile,
} from "../lib/db/influencer-dao.js";
import {
  isExplicitDoNotContact,
  updateBusinessProfileFromReply,
} from "../lib/influencer/business-profile.js";
import { seedKnownPlatformProfiles } from "../lib/influencer/business-profile-platform-identity.js";
import { applySystemQuoteCreatorResponse } from "../lib/billing/refund-system-quote.js";
import { getCampaignById, getExecutionRow } from "../lib/db/campaign-dao.js";
import { enqueueAdvertiserExecutionFollowup } from "../lib/execution/enqueue-advertiser-followup.js";
import { normalizeCommissionPercent } from "../lib/execution/agreed-terms.js";
import { resolveInfluencerThreadMailContext } from "../lib/email/influencer-thread-mail.js";
import { applyResidenceCountryFromDelta } from "../lib/influencer/country-reply-sync.js";
import {
  isCompleteShippingInfo,
  normalizeShippingInfo,
  resolveReusableShippingInfo,
  upsertInfluencerShippingInfo,
} from "../lib/execution/shipping-info.js";
import {
  extractPublishedLinksFromEmailBody,
  normalizePublishedLinksInput,
  mergePublishedLinkLists,
} from "../lib/execution/published-link-extraction.js";

const AUTO_REPLY_PATTERNS = [
  /thank you for your email/i,
  /we value your message/i,
  /will respond as soon as possible/i,
  /out of office/i,
  /automatic reply/i,
  /auto-?reply/i,
  /away from (my|the) (desk|office)/i,
];

/** LLM 决策失败最多重试次数（含首次），避免瞬时故障直接丢事件 */
const MAX_EMAIL_EVENT_ATTEMPTS = 3;

function isLikelyAutoReply(subject, bodyText) {
  const combined = `${subject || ""}\n${bodyText || ""}`.trim();
  if (!combined) return false;
  return AUTO_REPLY_PATTERNS.some((re) => re.test(combined));
}

function isBodyEffectivelyEmpty(bodyText) {
  return !String(bodyText || "").trim() || String(bodyText).trim().length < 15;
}

/** 从邮件正文兜底提取草稿/视频链接（LLM 未填 draftLink / videoLink 时） */
function extractLinksFromEmailBody(bodyText) {
  const text = String(bodyText || "");
  if (!text.trim()) return { draftLink: null, videoLink: null };

  const draftHostPatterns = [
    /https?:\/\/(?:drive|docs)\.google\.com\/[^\s<>"')\]]+/i,
    /https?:\/\/(?:www\.)?dropbox\.com\/[^\s<>"')\]]+/i,
    /https?:\/\/(?:www\.)?box\.com\/[^\s<>"')\]]+/i,
    /https?:\/\/we\.tl\/[^\s<>"')\]]+/i,
    /https?:\/\/(?:www\.)?mediafire\.com\/[^\s<>"')\]]+/i,
    /https?:\/\/(?:www\.)?icloud\.com\/[^\s<>"')\]]+/i,
  ];

  for (const re of draftHostPatterns) {
    const m = text.match(re);
    if (m) {
      return { draftLink: m[0].trim(), videoLink: null };
    }
  }

  const tiktok = text.match(
    /(https?:\/\/(?:www\.)?tiktok\.com\/@[^\s/]+\/video\/\d+)/i
  );
  if (tiktok) {
    return { draftLink: null, videoLink: tiktok[1] };
  }

  return { draftLink: null, videoLink: null };
}

/** 归一化 LLM 返回的双语邮件摘要：{ original: 邮件原文语言摘要, zh: 中文摘要 } */
function normalizeEmailSummary(raw) {
  if (raw == null) return null;
  let original = null;
  let zh = null;
  if (typeof raw === "string") {
    original = raw.trim() || null;
  } else if (typeof raw === "object") {
    original =
      typeof raw.original === "string" && raw.original.trim()
        ? raw.original.trim()
        : typeof raw.en === "string" && raw.en.trim()
          ? raw.en.trim()
          : null;
    zh =
      typeof raw.zh === "string" && raw.zh.trim()
        ? raw.zh.trim()
        : typeof raw.chinese === "string" && raw.chinese.trim()
          ? raw.chinese.trim()
          : null;
  }
  if (!original && !zh) return null;
  return { original, zh };
}

function normalizeDeliverableTextForCompare(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function latestSubmittedDeliverable(lastEvent, kind) {
  const timeline = Array.isArray(lastEvent?.deliverablesTimeline)
    ? lastEvent.deliverablesTimeline
    : [];
  return (
    [...timeline]
      .reverse()
      .find(
        (e) =>
          e?.kind === kind &&
          e?.role === "influencer" &&
          e?.type === "submitted"
      ) || null
  );
}

/**
 * 判断“只有邮件正文、没有新附件/新链接”的重复脚本提交：
 * 红人常把 PDF/脚本里已有的内容再粘贴一次，正文相同且仍引用同一条旧链接时，
 * 不应再追加一条新的 submitted 交付记录。
 */
function isDuplicateBodyOnlyDeliverable({ deliverable, exec }) {
  if (!deliverable || !deliverable.content) return false;
  if (deliverable.attachmentFilename) return false;
  if (!["script", "video_draft"].includes(deliverable.kind)) return false;

  const latest = latestSubmittedDeliverable(exec?.lastEvent, deliverable.kind);
  if (!latest?.content) return false;

  const contentSame =
    normalizeDeliverableTextForCompare(latest.content) ===
    normalizeDeliverableTextForCompare(deliverable.content);
  if (!contentSame) return false;

  // 没有新文件时，只有链接仍是旧链接才判定为重复便利粘贴；
  // 如果红人给了一条全新的脚本/草稿链接，即使正文相同也应视为重新提交。
  const oldLink = String(latest.link || "").trim();
  const newLink = String(deliverable.link || "").trim();
  if (oldLink && newLink && oldLink !== newLink) return false;
  if (newLink && !oldLink) return false;
  return true;
}
import {
  buildActionMessageId,
  buildTraceIdFromInboundMessageId,
} from "../lib/utils/timeline-ids.js";

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

async function fetchPendingEvents(limit = 10) {
  const n = Math.min(50, Math.max(1, Number(limit) || 10));
  const rows = await queryTikTok(
    `
    SELECT *
    FROM tiktok_influencer_email_events
    WHERE status = 'pending'
      AND influencer_id IS NOT NULL
    ORDER BY created_at ASC
    LIMIT ${n}
  `,
    []
  );
  return rows || [];
}

async function fetchActiveExecutionsForInfluencer(influencerId) {
  if (!influencerId) return [];
  const rows = await queryTikTok(
    `
    SELECT e.campaign_id,
           e.tiktok_username,
           e.influencer_id AS platform_influencer_id,
           e.stage,
           e.quote_origin,
           e.shipping_info,
           e.influencer_snapshot,
           e.last_event,
           c.product_info,
           c.campaign_info
    FROM tiktok_campaign_execution e
    JOIN tiktok_campaign c ON e.campaign_id = c.id
    WHERE ${SQL_EXECUTION_CREATOR_MATCH_E}
  `,
    [...paramsExecutionCreatorMatch(influencerId)]
  );

  return rows.map((r) => ({
    campaignId: r.campaign_id,
    influencerId: r.platform_influencer_id || r.tiktok_username,
    platformInfluencerId: r.platform_influencer_id || null,
    tiktokUsername: r.tiktok_username || null,
    stage: r.stage,
    quoteOrigin: r.quote_origin || null,
    shippingInfo: parseJsonOrObject(r.shipping_info),
    influencerSnapshot: parseJsonOrObject(r.influencer_snapshot),
    lastEvent: parseJsonOrObject(r.last_event),
    productInfo: parseJsonOrObject(r.product_info),
    campaignInfo: stripBudgetFromCampaignInfo(parseJsonOrObject(r.campaign_info)),
  }));
}

async function fetchAttachmentsForEvent(eventId) {
  if (!eventId) return [];
  const rows = await queryTikTok(
    `
    SELECT id, part, content_id, filename, content_type, size_bytes, content
    FROM tiktok_influencer_email_event_attachments
    WHERE event_id = ?
    ORDER BY id ASC
  `,
    [eventId]
  );
  return rows || [];
}

function cleanId(value) {
  const s = value == null ? "" : String(value).trim();
  return s || null;
}

function lowerId(value) {
  return String(value || "").trim().toLowerCase();
}

function resolveCanonicalInfluencerId({ requestedInfluencerId, event, exec }) {
  const execPlatformId = cleanId(exec?.platformInfluencerId);
  const eventInfluencerId = cleanId(event?.influencer_id);
  const requested = cleanId(requestedInfluencerId);

  if (!requested) {
    return execPlatformId || eventInfluencerId || cleanId(exec?.influencerId);
  }

  const requestedLower = lowerId(requested);
  const execHandleLower = lowerId(exec?.tiktokUsername);
  const execIdLower = lowerId(exec?.influencerId);
  const eventIdLower = lowerId(eventInfluencerId);

  if (
    execPlatformId &&
    (requestedLower === execHandleLower ||
      requestedLower === lowerId(execPlatformId) ||
      requestedLower === execIdLower)
  ) {
    return execPlatformId;
  }

  if (
    eventInfluencerId &&
    (requestedLower === eventIdLower || requestedLower === execHandleLower)
  ) {
    return eventInfluencerId;
  }

  return execPlatformId || eventInfluencerId || requested || cleanId(exec?.influencerId);
}

async function extractAttachmentText(att) {
  const contentType = String(att.content_type || "").toLowerCase();
  const filename = att.filename || "";
  const buf = att.content;
  if (!buf || !Buffer.isBuffer(buf)) return null;

  // PDF
  if (contentType.includes("pdf") || filename.toLowerCase().endsWith(".pdf")) {
    try {
      const mod = await import("pdf-parse");
      const pdfParse = mod.default || mod;
      const data = await pdfParse(buf);
      const text = (data?.text || "").trim();
      return text ? { kind: "pdf_text", text } : null;
    } catch (err) {
      return { kind: "pdf_text_error", text: `PDF 解析失败: ${err?.message || String(err)}` };
    }
  }

  // Image OCR
  if (contentType.startsWith("image/")) {
    try {
      const mod = await import("tesseract.js");
      const Tesseract = mod.default || mod;
      const r = await Tesseract.recognize(buf, "eng");
      const text = (r?.data?.text || "").trim();
      return text ? { kind: "image_ocr_text", text } : null;
    } catch (err) {
      return { kind: "image_ocr_error", text: `图片 OCR 失败: ${err?.message || String(err)}` };
    }
  }

  return null;
}

async function markEventStatus(id, status, errorMessage = null) {
  await queryTikTok(
    `
    UPDATE tiktok_influencer_email_events
    SET status = ?, error_message = ?, updated_at = NOW()
    WHERE id = ?
  `,
    [status, errorMessage, id]
  );
}

/**
 * LLM 决策失败处理：未达重试上限时重新入队（status=pending），
 * 否则标记 failed。attempt_count 用于记录已尝试次数。
 */
async function requeueOrFailEmailEvent(event, errorMessage) {
  const attempts = Number(event?.attempt_count || 0) + 1;
  if (attempts < MAX_EMAIL_EVENT_ATTEMPTS) {
    await queryTikTok(
      `
      UPDATE tiktok_influencer_email_events
      SET status = 'pending',
          attempt_count = ?,
          error_message = ?,
          updated_at = NOW()
      WHERE id = ?
    `,
      [attempts, String(errorMessage || "").slice(0, 2000), event.id]
    );
    console.warn(
      `[ProcessInfluencerEmailEvents] 事件 ${event.id} 第 ${attempts} 次处理失败，已重新入队等待重试: ${errorMessage}`
    );
    return;
  }
  await markEventStatus(event.id, "failed", errorMessage);
  console.error(
    `[ProcessInfluencerEmailEvents] 事件 ${event.id} 重试 ${MAX_EMAIL_EVENT_ATTEMPTS} 次仍失败，标记 failed: ${errorMessage}`
  );
}

async function createCampaignAgentEvent({
  campaignId,
  influencerId,
  eventType,
  payload,
}) {
  const r = await queryTikTok(
    `
    INSERT INTO tiktok_advertiser_agent_event (
      campaign_id,
      influencer_id,
      event_type,
      payload,
      status
    )
    VALUES (?, ?, ?, ?, 'pending')
  `,
    [campaignId || null, influencerId || null, eventType, JSON.stringify(payload || {})]
  );
  return r?.insertId || null;
}

async function sendOrDraftReplyEmail({
  influencerId,
  campaignId = null,
  fromAccount,
  toEmail,
  subject,
  bodyText,
  headers,
  sourceEventId,
  traceId,
  inboundMessageId = null,
}) {
  const fromEmail =
    fromAccount.email ||
    fromAccount.email_address ||
    fromAccount.username ||
    fromAccount.account ||
    null;
  const handoverMode = (await getInfluencerHandoverMode(influencerId)) || "auto";

  if (handoverMode === "assist") {
    await logDraftOutboundMessage({
      influencerId,
      campaignId,
      fromEmail,
      toEmail,
      subject,
      bodyText,
      sourceType: "llm_outbound_email",
      sourceEventTable: "tiktok_influencer_email_events",
      sourceEventId,
      triggerType: "inbound_auto_reply",
      traceId,
      payload: {
        email: {
          to: toEmail,
          subject,
          inReplyTo: inboundMessageId,
        },
        source: {
          eventTable: "tiktok_influencer_email_events",
          eventId: sourceEventId,
          triggerType: "inbound_auto_reply",
        },
      },
    });
    return { drafted: true, fromEmail, result: null, sendErr: null };
  }

  let result = null;
  let sendErr = null;
  try {
    result = await sendMail({
      fromAccount,
      to: toEmail,
      subject,
      text: bodyText,
      headers,
    });
  } catch (err) {
    sendErr = err;
  }
  return { drafted: false, fromEmail, result, sendErr };
}

async function handleOutboundEmails(decision, event, executions) {
  if (!decision || !Array.isArray(decision.outboundEmails)) return;

  // 收到红人回邮后在本 Worker 发信；线程与发件人与其它 Bin→红人路径一致（见 influencer-thread-mail）。

  for (const email of decision.outboundEmails) {
    if (!email || typeof email !== "object") continue;

    const exec =
      (email.campaignId &&
        executions.find((e) => e.campaignId === email.campaignId)) ||
      executions[0] ||
      null;

    const campaignId = email.campaignId || exec?.campaignId || null;
    const canonicalId = resolveCanonicalInfluencerId({
      requestedInfluencerId: email.influencerId,
      event,
      exec,
    });
    // 统一归一化成平台 influencer_id，禁止 handle/用户名落库
    const influencerId = await normalizeCanonicalInfluencerId(canonicalId);

    const to = email.to || event.from_email;

    const influencerRow =
      influencerId && (await getInfluencerById(influencerId).catch(() => null));
    if (influencerRow?.contactStatus === "do_not_contact") continue;

    const ctx = await resolveInfluencerThreadMailContext({
      influencerId,
      influencer: influencerRow,
      preferredInReplyToMessageId: email.inReplyTo || event.message_id || null,
    });
    const fromAccount = ctx.fromAccount;

    const subject =
      (email.subject && String(email.subject).trim()) || ctx.subjectForSend;
    const body = email.body || email.bodyText || "";
    const inboundMessageId = email.inReplyTo || event.message_id || null;
    const traceId = buildTraceIdFromInboundMessageId(inboundMessageId);

    const headers = {
      "X-Maxin-Influencer-Id": influencerId || "",
      "X-Maxin-Campaign-Id": campaignId || "",
      "X-Maxin-Source": "InfluencerAgent",
    };
    if (ctx.inReplyTo) {
      headers["In-Reply-To"] = ctx.inReplyTo;
    }
    if (ctx.references) {
      headers["References"] = ctx.references;
    }

    const delivery = await sendOrDraftReplyEmail({
      influencerId,
      campaignId,
      fromAccount,
      toEmail: to,
      subject,
      bodyText: body,
      headers,
      sourceEventId: event.id,
      traceId,
      inboundMessageId,
    });
    if (delivery.drafted) continue;
    const { result, sendErr, fromEmail } = delivery;

    // 写入对话记忆表
    try {
      await logConversationMessage({
        influencerId,
        campaignId,
        direction: "bin",
        channel: "email",
        fromEmail,
        toEmail: to,
        subject,
        bodyText: body,
        messageId: result?.messageId || null,
        sourceType: "llm_outbound_email",
        sourceEventTable: "tiktok_influencer_email_events",
        sourceEventId: event.id,
        sentAt: new Date(),
        eventType: "email_outbound",
        eventTime: new Date(),
        actorType: "agent",
        sendMode: "auto_send",
        contentOrigin: "agent_generated",
        traceId,
        payload: {
          kind: "email_outbound",
          status: sendErr ? "failed" : "succeeded",
          error: sendErr ? { message: sendErr?.message || String(sendErr) } : null,
          email: {
            to,
            subject,
            inReplyTo: inboundMessageId,
            messageId: result?.messageId || null,
          },
        },
      });
    } catch (err) {
      console.error(
        "[ProcessInfluencerEmailEvents] 写入 tiktok_influencer_conversation_messages 失败:",
        err
      );
    }

    if (sendErr) {
      console.error(
        "[ProcessInfluencerEmailEvents] sendMail 失败：",
        sendErr?.message || sendErr
      );
    } else {
      // 报价阶段（价格还没谈定）发出的每一封回信都算一轮「追问价格」，
      // 供下一轮决策判断是否已达到追问上限（见 prompt「报价阶段纪律」）。
      await bumpQuoteFollowUpCount({ campaignId, exec }).catch(() => {});
    }
  }
}

/**
 * 报价阶段追问计数 +1：只统计仍在「待报价」的执行（stage = pending_quote）。
 * 固定费/佣金都明确后由 campaign agent worker 侧清零；用于封顶追问轮数（≤3 轮）。
 */
async function bumpQuoteFollowUpCount({ campaignId, exec }) {
  const influencerId = exec?.influencerId;
  if (!campaignId || !influencerId) return;
  await queryTikTok(
    `
    UPDATE tiktok_campaign_execution
    SET last_event = JSON_SET(
          COALESCE(last_event, JSON_OBJECT()),
          '$.quoteFollowUpCount',
          COALESCE(JSON_EXTRACT(last_event, '$.quoteFollowUpCount'), 0) + 1
        )
    WHERE campaign_id = ?
      AND stage = 'pending_quote'
      AND ${SQL_EXECUTION_CREATOR_MATCH_E}
  `,
    [campaignId, ...paramsExecutionCreatorMatch(influencerId)]
  );
}

async function handleAgentEvents(decision, event, executions) {
  if (!decision || !Array.isArray(decision.agentEvents)) return;

  for (const ae of decision.agentEvents) {
    if (!ae || typeof ae !== "object") continue;

    const exec =
      (ae.campaignId &&
        executions.find((e) => e.campaignId === ae.campaignId)) ||
      executions[0] ||
      null;

    const campaignId = ae.campaignId || exec?.campaignId || null;
    const influencerId = resolveCanonicalInfluencerId({
      requestedInfluencerId: ae.influencerId,
      event,
      exec,
    });
    const execHandle =
      exec?.tiktokUsername != null ? String(exec.tiktokUsername).trim() : "";
    const tiktokUsername =
      (typeof ae.tiktokUsername === "string" && ae.tiktokUsername.trim()
        ? ae.tiktokUsername.trim().replace(/^@/, "")
        : execHandle && !/^\d+$/.test(execHandle)
          ? execHandle.replace(/^@/, "")
          : null) || null;
    const eventType = ae.type || ae.eventType || "generic";

    const payload = {
      ...ae,
      campaignId,
      influencerId,
      ...(tiktokUsername ? { tiktokUsername } : {}),
      source: "influencer_email_agent",
      sourceEventId: event.id,
      sourceMessageId: event.message_id,
      createdAt: new Date().toISOString(),
    };

    const advEventId = await createCampaignAgentEvent({
      campaignId,
      influencerId,
      eventType,
      payload,
    });

    // 记录 agent_action 到时间线
    try {
      const inboundMessageId = event.message_id || null;
      const traceId = buildTraceIdFromInboundMessageId(inboundMessageId);
      const actionName = `write_adv_event:${eventType}`;
      await logConversationMessage({
        influencerId,
        campaignId,
        direction: "bin",
        channel: "email",
        fromEmail: null,
        toEmail: null,
        subject: null,
        bodyText: `[agent_action] ${actionName}`,
        messageId: buildActionMessageId(inboundMessageId, actionName),
        sourceType: "influencer_agent_event",
        sourceEventTable: "tiktok_advertiser_agent_event",
        sourceEventId: advEventId,
        sentAt: new Date(),
        eventType: "agent_action",
        eventTime: new Date(),
        actorType: "agent",
        traceId,
        payload: {
          actionName,
          advertiserAgentEventId: advEventId,
          advertiserEventType: eventType,
          campaignId,
          influencerId,
        },
      });
    } catch (err) {
      console.error(
        "[ProcessInfluencerEmailEvents] 写入 agent_action 时间线失败:",
        err
      );
    }
  }
}

async function applySystemQuoteResponses(decision, event, executions) {
  const responses = Array.isArray(decision?.systemQuoteResponses)
    ? decision.systemQuoteResponses
    : [];
  for (const item of responses) {
    const exec = executions.find((row) => row.campaignId === item?.campaignId);
    if (!exec || exec.stage !== "pending_creator_confirmation") continue;
    const influencerId = resolveCanonicalInfluencerId({
      requestedInfluencerId: item.influencerId,
      event,
      exec,
    });
    const result = await applySystemQuoteCreatorResponse({
      campaignId: exec.campaignId,
      influencerId,
      response: item.response,
      newAmountUsd: item.newAmountUsd,
      note: item.note || event.body_text || null,
      sourceMessageId: event.message_id || null,
    });
    if (result?.success && item.response === "accepted") {
      const [campaign, executionRow] = await Promise.all([
        getCampaignById(exec.campaignId),
        getExecutionRow(exec.campaignId, exec.influencerId),
      ]);
      await enqueueAdvertiserExecutionFollowup({
        campaignId: exec.campaignId,
        influencerId: exec.influencerId,
        action: "approveQuote",
        campaign,
        executionRow,
        payload: { source: "creator_system_quote_acceptance" },
      });
    }
  }
}

async function applyDecision(decision, event, executions) {
  // 目前支持的最小决策格式：
  // decision = { updates: [ { campaignId, newStage, note } ] }
  if (!decision || !Array.isArray(decision.updates)) return;

  for (const upd of decision.updates) {
    const { campaignId, newStage, note } = upd;
    if (!campaignId || !newStage) continue;

    const exec = executions.find((e) => e.campaignId === campaignId);
    if (!exec) continue;

    // 解析可选的报价 / 视频链接 / 寄样信息
    let flatFee =
      typeof upd.flatFeeUSD === "number"
        ? upd.flatFeeUSD
        : upd.flatFeeUSD && !Number.isNaN(Number(upd.flatFeeUSD))
        ? Number(upd.flatFeeUSD)
        : null;
    // 执行级佣金：与固定费同规则；0 = 明确谈定为零，null = 未谈定（禁止用 0 代替未谈定）
    let commissionPercent = normalizeCommissionPercent(upd.commissionPercent);

    let videoLink =
      typeof upd.videoLink === "string" && upd.videoLink.trim()
        ? upd.videoLink.trim()
        : null;

    let draftLink =
      typeof upd.draftLink === "string" && upd.draftLink.trim()
        ? upd.draftLink.trim()
        : null;

    let deliverable = null;
    if (upd.deliverable && typeof upd.deliverable === "object") {
      const dKind = upd.deliverable.kind;
      const dType = upd.deliverable.type;
      deliverable = {
        kind:
          dKind === "script" || dKind === "video_draft" || dKind === "published"
            ? dKind
            : null,
        type: dType === "published_link" ? "published_link" : "submitted",
        content:
          typeof upd.deliverable.content === "string"
            ? upd.deliverable.content.trim().slice(0, 20000) || null
            : null,
        link:
          typeof upd.deliverable.link === "string" &&
          upd.deliverable.link.trim()
            ? upd.deliverable.link.trim().slice(0, 1024)
            : null,
        attachmentFilename:
          typeof upd.deliverable.attachmentFilename === "string" &&
          upd.deliverable.attachmentFilename.trim()
            ? upd.deliverable.attachmentFilename.trim().slice(0, 255)
            : null,
        emailSummary: normalizeEmailSummary(upd.deliverable.emailSummary),
      };
      if (
        deliverable.kind == null &&
        deliverable.content == null &&
        deliverable.link == null &&
        deliverable.attachmentFilename == null &&
        deliverable.emailSummary == null
      ) {
        deliverable = null;
      }
    }

    if (
      deliverable &&
      isDuplicateBodyOnlyDeliverable({ deliverable, exec })
    ) {
      console.warn(
        `[ProcessInfluencerEmailEvents] 拦截重复便利粘贴：${campaignId}/${exec?.influencerId} 未新增附件/链接，正文与最新 ${deliverable.kind} 提交相同，不追加 submitted。`
      );
      continue;
    }

    let promoCode =
      typeof upd.promoCode === "string" && upd.promoCode.trim()
        ? upd.promoCode.trim().slice(0, 255)
        : null;

    // 多平台发布链接：LLM 的 publishedLinks 优先，邮件正文兜底补齐，单值 videoLink 兼容
    let publishedLinks = normalizePublishedLinksInput(upd.publishedLinks);
    if (event.body_text && (videoLink || deliverable?.kind === "published")) {
      publishedLinks = mergePublishedLinkLists(
        publishedLinks,
        extractPublishedLinksFromEmailBody(event.body_text)
      );
    }
    if (deliverable?.kind === "published" && deliverable.link) {
      publishedLinks = mergePublishedLinkLists(publishedLinks, [
        { platform: null, url: deliverable.link, promoCode },
      ]);
    }
    if (videoLink) {
      publishedLinks = mergePublishedLinkLists(publishedLinks, [
        { platform: null, url: videoLink, promoCode },
      ]);
    }

    let shippingInfo =
      upd.shippingInfo && typeof upd.shippingInfo === "object"
        ? normalizeShippingInfo(upd.shippingInfo)
        : null;
    const shippingComplete = isCompleteShippingInfo(shippingInfo);
    if (shippingInfo && shippingComplete) {
      await upsertInfluencerShippingInfo({
        influencerId: exec.platformInfluencerId || exec.influencerId,
        shippingInfo,
        sourceMessageId: event.message_id || null,
        sourceCampaignId: campaignId,
        source: "influencer_email",
        confirmedAt: event.received_at
          ? new Date(event.received_at).toISOString()
          : new Date().toISOString(),
      }).catch((err) => {
        console.warn(
          "[ProcessInfluencerEmailEvents] 红人常用寄样信息回写失败:",
          err?.message || err
        );
      });
    }

    // 简单兜底解析：从邮件正文中提取报价（如 "200 dollars"）和 TikTok 视频链接
    if (flatFee == null && event.body_text) {
      const m = event.body_text.match(
        /(\d+(?:\.\d+)?)\s*(USD|usd|dollars?|美金|刀)\b/
      );
      if (m) {
        const v = Number(m[1]);
        if (!Number.isNaN(v)) flatFee = v;
      }
    }

    if (!videoLink && !draftLink && event.body_text) {
      const parsed = extractLinksFromEmailBody(event.body_text);
      if (parsed.draftLink) draftLink = parsed.draftLink;
      if (parsed.videoLink) videoLink = parsed.videoLink;
    }

    // 兜底：LLM 未返回 deliverable 时，按阶段推断（有脚本通过标记→视频草稿，否则脚本/发布链接）
    if (!deliverable && (draftLink || videoLink)) {
      const lastEvent = exec?.lastEvent || {};
      const timeline = Array.isArray(lastEvent.deliverablesTimeline)
        ? lastEvent.deliverablesTimeline
        : [];
      const hasScriptApproved = Boolean(
        lastEvent.scriptApprovedAt ||
          timeline.some(
            (e) => e?.kind === "script" && e?.type === "approved"
          )
      );
      deliverable = {
        kind: videoLink ? "published" : hasScriptApproved ? "video_draft" : "script",
        type: videoLink ? "published_link" : "submitted",
        content: null,
        link: draftLink || videoLink,
        attachmentFilename: null,
      };
    }
    if (
      deliverable &&
      deliverable.kind === "script" &&
      !deliverable.content &&
      !deliverable.link &&
      event.body_text
    ) {
      deliverable = { ...deliverable, content: event.body_text.trim() };
    }

    const payload = {
      type: upd.type || "execution_update_suggested",
      campaignId,
      influencerId: exec.influencerId,
      newStage,
      note: note || "",
      flatFeeUSD: flatFee,
      commissionPercent,
      draftLink,
      videoLink,
      deliverable,
      promoCode,
      publishedLinks,
      shippingInfo,
      emailEvent: {
        id: event.id,
        messageId: event.message_id,
        subject: event.subject || "",
        fromEmail: event.from_email,
        toEmail: event.to_email,
        bodyText: event.body_text || "",
      },
      parsedFromEmailBody: {
        flatFeeUSD: flatFee,
        commissionPercent,
        draftLink,
        videoLink,
        deliverable,
        promoCode,
        publishedLinks,
      },
      createdAt: new Date().toISOString(),
    };

    const advEventId = await createCampaignAgentEvent({
      campaignId,
      influencerId: exec.influencerId,
      eventType: payload.type,
      payload,
    });

    // 记录 agent_action 到时间线（更新建议写入 advertiser agent event）
    try {
      const inboundMessageId = event.message_id || null;
      const traceId = buildTraceIdFromInboundMessageId(inboundMessageId);
      const actionName = `write_adv_event:${payload.type}`;
      await logConversationMessage({
        influencerId: exec.influencerId,
        campaignId,
        direction: "bin",
        channel: "email",
        fromEmail: null,
        toEmail: null,
        subject: null,
        bodyText: `[agent_action] ${actionName}`,
        messageId: buildActionMessageId(inboundMessageId, actionName),
        sourceType: "influencer_agent_event",
        sourceEventTable: "tiktok_advertiser_agent_event",
        sourceEventId: advEventId,
        sentAt: new Date(),
        eventType: "agent_action",
        eventTime: new Date(),
        actorType: "agent",
        traceId,
        payload: {
          actionName,
          advertiserAgentEventId: advEventId,
          advertiserEventType: payload.type,
          campaignId,
          influencerId: exec.influencerId,
        },
      });
    } catch (err) {
      console.error(
        "[ProcessInfluencerEmailEvents] 写入 agent_action（applyDecision）失败:",
        err
      );
    }
  }
}

/**
 * 方案 2：事件决策 LLM 已返回 profileDelta，这里按需落地商务档案与红人常住地。
 *
 * - 常住地：只有 relation=self_residence + 原句证据 + 置信度过线才会写库
 *   （护栏在 lib/influencer/country-reply-sync.js）。
 * - 商务档案：只有 hasProfileUpdate=true 时才调那次 LLM 重写 markdown，
 *   纯寒暄/进度更新不再调用 → 每封回复通常只花 1 次 LLM。
 * - doNotContact：置为免打扰并终止本事件后续动作（不回信）。
 *
 * 本函数只做「落库/维护」，不推进 stage，也不发信——那些仍由既有
 * applySystemQuoteResponses / applyDecision / handleOutboundEmails 负责。
 */
async function applyMaintenanceFromDecision({
  decision,
  event,
  executions,
  influencerRow,
  influencerId,
  conversationHistory,
  businessProfileMarkdownForPrompt = null,
}) {
  const result = { country: null, profile: null, stopProcessing: false };
  const delta = decision?.profileDelta || null;
  if (!influencerRow || !influencerId || !delta) return result;
  if (
    isLikelyAutoReply(event.subject, event.body_text) ||
    isBodyEffectivelyEmpty(event.body_text)
  ) {
    return result;
  }

  if (delta.doNotContact) {
    await markInfluencerDoNotContact({
      influencerId,
      reason: delta.doNotContactReason || event.body_text,
      sourceMessageId: event.message_id || null,
    });
    result.stopProcessing = true;
    return result;
  }

  try {
    result.country = await applyResidenceCountryFromDelta({
      influencerId,
      profileDelta: delta,
      event,
      executions,
    });
  } catch (err) {
    result.country = { changed: false, error: err?.message || String(err) };
    console.warn(
      "[ProcessInfluencerEmailEvents] 国家信息回写失败:",
      err?.message || err
    );
  }

  if (delta.hasProfileUpdate) {
    try {
      result.profile = await updateBusinessProfileFromReply({
        influencer:
          businessProfileMarkdownForPrompt != null
            ? {
                ...influencerRow,
                businessProfileMarkdown: businessProfileMarkdownForPrompt,
              }
            : influencerRow,
        email: {
          subject: event.subject || "",
          bodyText: event.body_text || "",
          messageId: event.message_id || null,
          receivedAt: event.received_at || event.created_at || null,
        },
        conversationHistory,
        profileDelta: delta,
      });
      if (result.profile?.doNotContact) {
        await markInfluencerDoNotContact({
          influencerId,
          reason: result.profile.doNotContactReason || event.body_text,
          sourceMessageId: event.message_id || null,
        });
        result.stopProcessing = true;
        return result;
      }
      if (result.profile?.changed && result.profile.profileMarkdown) {
        await updateInfluencerBusinessProfile({
          influencerId,
          markdown: result.profile.profileMarkdown,
          sourceMessageId: event.message_id || null,
        });
      }
    } catch (err) {
      result.profile = { changed: false, error: err?.message || String(err) };
      console.warn(
        "[ProcessInfluencerEmailEvents] 商务档案更新失败:",
        err?.message || err
      );
    }
  }

  return result;
}

async function processEvent(event) {
  await markEventStatus(event.id, "processing", null);

  const executions = await fetchActiveExecutionsForInfluencer(
    event.influencer_id
  );
  const canonicalEventInfluencerId =
    cleanId(executions.find((e) => e.platformInfluencerId)?.platformInfluencerId) ||
    cleanId(event.influencer_id);

  const conversationHistory = await loadConversationHistoryForInfluencer(
    canonicalEventInfluencerId,
    20
  );
  const reusableShippingInfo = canonicalEventInfluencerId
    ? await resolveReusableShippingInfo(canonicalEventInfluencerId).catch((err) => {
        console.warn(
          "[ProcessInfluencerEmailEvents] 读取历史寄样信息失败:",
          err?.message || err
        );
        return null;
      })
    : null;

  const influencerRow =
    canonicalEventInfluencerId &&
    (await getInfluencerById(canonicalEventInfluencerId).catch(() => null));
  const platformIdentities = canonicalEventInfluencerId
    ? await listInfluencerPlatformIdentities(canonicalEventInfluencerId).catch(
        () => []
      )
    : [];
  if (influencerRow && isExplicitDoNotContact(event.body_text)) {
    await markInfluencerDoNotContact({
      influencerId: canonicalEventInfluencerId,
      reason: event.body_text,
      sourceMessageId: event.message_id || null,
    });
    await markEventStatus(event.id, "succeeded", null);
    return;
  }
  // 商务档案 / 常住地维护已改为「事件决策 LLM 先判定，再按需触发」：
  // profileDelta 由下方决策 LLM 返回，applyMaintenanceFromDecision 负责落库。
  // 已知平台身份（如 YouTube @mixallin1）直接补进档案，避免把已有账号当成 Unknown 再问。
  const seededBusinessProfileMarkdown = seedKnownPlatformProfiles(
    influencerRow?.businessProfileMarkdown || "",
    platformIdentities
  );
  const threadMailCtx = await resolveInfluencerThreadMailContext({
    influencerId: canonicalEventInfluencerId,
    influencer: influencerRow,
    preferredInReplyToMessageId: event.message_id || null,
  });

  const payload = {
    influencerId: canonicalEventInfluencerId || null,
    email: {
      from: event.from_email,
      to: event.to_email,
      subject: event.subject,
      bodyText: event.body_text,
      bodyEffectivelyEmpty: isBodyEffectivelyEmpty(event.body_text),
      likelyAutoReply: isLikelyAutoReply(event.subject, event.body_text),
      messageId: event.message_id,
      inReplyTo: event.in_reply_to,
      createdAt: event.created_at,
      attachments: [],
    },
    activeExecutions: executions,
    reusableShippingInfo,
    conversationHistory,
    existingBusinessProfileMarkdown:
      seededBusinessProfileMarkdown || null,
    threadInfo: {
      canonicalThreadSubject: threadMailCtx.canonicalBase,
      rootMessageId: threadMailCtx.rootMessageId,
      parentMessageId: threadMailCtx.parentMessageId,
      suggestedSubjectForReply: threadMailCtx.subjectForSend,
    },
  };

  // 读取附件并提取可读文本（给 LLM）
  try {
    const atts = await fetchAttachmentsForEvent(event.id);
    const attachmentsPayload = [];
    for (const a of atts) {
      const extracted = await extractAttachmentText(a);
      attachmentsPayload.push({
        filename: a.filename || null,
        contentType: a.content_type || null,
        sizeBytes: a.size_bytes || null,
        part: a.part || null,
        contentId: a.content_id || null,
        extractedText: extracted?.text || null,
        extractedKind: extracted?.kind || null,
      });
    }
    payload.email.attachments = attachmentsPayload;
  } catch (err) {
    payload.email.attachments = [
      {
        filename: null,
        contentType: null,
        sizeBytes: null,
        part: null,
        contentId: null,
        extractedText: `读取/解析附件失败: ${err?.message || String(err)}`,
        extractedKind: "attachments_error",
      },
    ];
  }

  const systemPrompt = `
${influencerAgentBasePrompt}

【红人不满 / 质疑 / 投诉 / 法律风险处理（极其重要）】
- 当红人表达不满、质疑公司真实性、投诉未兑现承诺，或提及投诉/律师/举报等时：
  - 优先真诚道歉并如实披露：Bin 是 Binfluencer 创始人开发的 AI talent manager；公司官网是 https://www.binfluencer.xyz；产品处于早期阶段，愿景是帮助全球创作者获得专业、普惠的红人经纪人服务。
  - 不得辩解、推卸责任或暗示是红人误会；不得继续伪装人类或虚构公司背景。
  - 不得再承诺无法兑现的事项（如「马上发会议链接」「品牌稍后发官方邮件」）；如需要提供联系方式，给出 bin@binfluencer.xyz。
  - 公司身份与官网口径以共享 base prompt 为准：禁止编造域名、LinkedIn 主页或机构隶属关系。

【当前任务：处理红人邮件事件并给出业务决策】
- 你正收到一封红人发来的最新邮件（email），你还可以看到：
  - conversationHistory：你与该红人的历史对话记录；
  - activeExecutions：该红人在各个 campaign 下当前的执行状态；
  - threadInfo：规范化线程标题（canonicalThreadSubject）、根/父 Message-ID、以及建议的续信标题（suggestedSubjectForReply，通常为 Re: + 规范化标题）。
- 你的目标是：在尊重红人体验的前提下，做出合理的业务决策，并通过结构化 JSON 告诉系统要做什么。
- profileDelta.questions 若非空，须在正常业务回复结尾自然询问这些缺失或待确认项目；不要重复询问已有信息（见 existingBusinessProfileMarkdown）。
- 本封若从红人处确认了常住国家（profileDelta.residenceRelation="self_residence"），系统会据此回写红人国家；后续邮件不要重复询问所在国家。

输入 JSON 中包含：
- email：当前这封邮件的关键信息；
- activeExecutions：该红人当前所有相关执行记录；
- existingBusinessProfileMarkdown：该红人已确认的商务档案（Markdown，可能为空模板）；用于判断本轮有哪些新事实、还缺哪些信息；
- reusableShippingInfo：系统从红人级记忆或最近历史对话中找到的最近一次完整寄样信息（如有）。当需要确认历史地址时，邮件中允许展示完整地址给红人确认。
- conversationHistory：按时间倒序的最近若干条对话消息（Bin 与红人的往来，direction=bin/ influencer）。
  - 你需要基于 conversationHistory「续写对话」，而不是重新自我介绍或重复问过的问题。
  - 若 conversationHistory 含多条不同 campaignId，你必须在 outboundEmails 的 body / updates 的 note 中区分对应 campaignId，避免混淆。
  - 如果你不填 outboundEmails[].subject，系统会使用 threadInfo.suggestedSubjectForReply（规范化 Re: 标题），不要照抄 email.subject 作为线程标题。

你在决策前，应优先阅读 conversationHistory，了解历史上下文（之前问过什么、红人答复过什么），再结合当前 email 与 activeExecutions 做出决定。

重要约束（输出格式）：
- 你只能返回 JSON，不能包含任何多余文字。
- JSON 顶层结构必须是：
  {
    "updates": [
      {
        "campaignId": "CAMP-xxx",
        "newStage": "quote_submitted",
        "note": "简要中文说明你为什么这么做",
        "flatFeeUSD": 200,
        "commissionPercent": 10,
        "draftLink": "https://...（真实脚本/草稿链接；禁止填参考图链接，可选）",
        "videoLink": "https://www.tiktok.com/@xxx/video/456",
        "deliverable": {
          "kind": "script|video_draft|published",
          "type": "submitted|published_link",
          "content": "脚本/草稿正文（从邮件正文或附件提取，去掉寒暄客套；无正文可省略）",
          "link": "真实的脚本/草稿链接；禁止填邮件里 Google Drive 参考图链接（可选）",
          "attachmentFilename": "附件文件名（脚本/草稿以附件提交时填，须与 email.attachments[].filename 完全一致，可选）",
          "emailSummary": {
            "original": "红人来信原文语言的 1-2 句摘要：这封邮件提交了什么、在等什么",
            "zh": "同一摘要的中文版本，供内部阅读"
          }
        },
        "promoCode": "投流码（红人提交最终发布链接时如有，可选）",
        "publishedLinks": [
          {
            "platform": "youtube|instagram|tiktok|x",
            "url": "该平台已发布视频链接",
            "promoCode": "该平台的投流码/推广码/UTM（如有，可选）"
          }
        ],
        "shippingInfo": {
          "name": "xxx",
          "phone": "xxx",
          "addressLine1": "xxx",
          "city": "xxx",
          "country": "xxx",
          "postalCode": "xxx"
        }
      }
    ],
    "outboundEmails": [
      {
        "campaignId": "CAMP-xxx",          // 可选，用于绑定某个执行
        "influencerId": "7123...",         // 可选，默认使用当前事件的 influencerId
        "to": "influencer@example.com",    // 可选，默认发给当前邮件的 from
        "subject": "Re: xxx",              // 可选，如不确定可以留空，由系统统一使用线程标题
        "body": "邮件正文（英文或中英均可）",
        "inReplyTo": "原邮件的 Message-ID（可选，如果不填则默认回复当前这封邮件）",
        "reason": "简要说明为什么要发这封邮件"
      }
    ],
    "agentEvents": [
      {
        "type": "timeline_change_confirmed",   // 事件类型（给 Campaign 执行 Agent）
        "campaignId": "CAMP-xxx",             // 建议填写
        "influencerId": "7123...",            // 建议填写
        "message": "红人已同意把发布时间从 3.1 改到 3.3",
        "extra": { "oldPublishDate": "2025-03-01", "newPublishDate": "2025-03-03" }
      },
      {
        "type": "creator_replied_special_request",    // 红人对某个特殊请求的回复
        "campaignId": "CAMP-xxx",                     // 建议填写
        "influencerId": "7123...",                    // 建议填写
        "specialRequestId": "SR-20260308-0001",       // 一轮特殊请求会话的唯一 ID
        "specialRequestStatus": "resolved",           // 红人同意时用 resolved；红人拒绝或需品牌再决定时用 pending_brand
        "creatorMessage": "I can do 300 for 2 + 200 for 1 more, and prefer posting on March 20.",
        "note": "用简明中文总结红人态度和关键信息，方便执行侧阅读",
        "contractUpdate": {                            // 可选：仅当本轮就「合同条款」达成一致时才填
          "sourceSpecialRequestId": "SR-20260308-0001",
          "additionalTerms": ["正式英文条款全文，写入合同的 4. Additional Terms；与固定条款不冲突的新增内容"],  // 可选
          "sectionOverrides": { "paymentTiming": "3.2 Payment Timing. 完整替换文本（含编号）" },            // 可选，仅用于与固定条款冲突、直接改写该条款
          "changeSummary": "一句话说明本次更新了什么（用于重发新合同的邮件）"                                  // 可选
        }
      }
    ],
    "systemQuoteResponses": [
      {
        "campaignId": "CAMP-xxx",
        "response": "accepted|declined|countered",
        "newAmountUsd": 800,
        "note": "红人对系统建议合作和价格的明确回复摘要"
      }
    ],
    "profileDelta": {
      "hasProfileUpdate": true,
      "residenceCountry": "JP",
      "residenceRelation": "self_residence|self_travel|other|quoted_history|unknown",
      "residenceEvidenceQuote": "I'm based in Osaka, Japan.",
      "residenceConfidence": 0.9,
      "facts": ["本轮新增或变更的商务档案事实（中文简述，没有就空数组）"],
      "questions": ["本轮要在回信里追问的档案缺项（英文，没有就空数组）"],
      "doNotContact": false,
      "doNotContactReason": null
    }
  }

【商务档案与常住地增量 · profileDelta（每封回复都必须返回这个对象）】
- profileDelta 只描述**本轮这封邮件**带来的新信息，不是整份档案；没有新信息就全部留空/false。
- residenceCountry 只填**红人本人常驻的国家**，用 ISO 3166-1 alpha-2 码（JP / US / ID …）。判断依据必须是第一人称、现在时、且有长期性，例如 "I'm based in Japan"、"I live in Osaka"、"我常驻日本"。
- residenceRelation 必须如实标注，它决定系统是否写库：
  - self_residence：红人明确说自己常住/居住在某个国家——**只有这个取值会被系统写库**；
  - self_travel：只是旅行、出差或临时停留；
  - other：说的是别人或别的东西，例如「你们的客户来自中国吗」「my audience is mostly in the US」、物流目的地、机构所在地；
  - quoted_history：只出现在下方被引用的历史邮件里；
  - unknown：本轮没有提到。
- residenceEvidenceQuote 必须逐字摘抄邮件里支撑该结论的原文句子（英文/原文语言）。没有原句就不要填 residenceCountry。
- 明确排除：反问句与疑问句、your agency / your clients / our audience 之类的主体、货币（JPY/USD 等）、语言、时区、签名与人名公司名里的地名、引用历史里的国家。旅行中的临时位置不算常住地。
- facts：本轮新增或变更的档案事实（最低报价、内容类别偏好/排除、可用性等），用于更新商务档案。
- questions：对照 existingBusinessProfileMarkdown，列出仍然缺失或需要澄清的档案项（最低报价、内容类别、可用性等）；**必须**在本次 outboundEmails 的正文结尾用自然的英文追问这些问题，不要写成表单，也不要重复询问档案里已有的信息。只填事实类问题，不要问国家。
- hasProfileUpdate：facts 非空，或本轮修改了既有档案事实时为 true；纯寒暄、进度更新、仅追问缺项时为 false。
- doNotContact / doNotContactReason：红人明确要求停止联系，或提及投诉、律师、举报时为 true 并简述原因；否则 false / null。

- updates 会被写入 tiktok_advertiser_agent_event，由后台 worker 落库；**stage 变更受状态机约束**，越权变更会被拦截，但报价/寄样/草稿/视频链接等字段仍可能写入。
- activeExecutions 中 stage=pending_creator_confirmation 时，只能在红人明确接受、拒绝或提出新价格后填写 systemQuoteResponses。不要同时为同一 campaign 填 updates。
- 填写 systemQuoteResponses 后不要再为该 campaign 生成 outboundEmails；系统会按最终状态发送下一步邮件，拒绝或新报价则无需自动回复。
- 红人接受时 response=accepted；拒绝时 response=declined；提出不同价格时 response=countered，并将外币报价合理估算为 USD 后填 newAmountUsd。
- 含糊回复、自动回复或“稍后答复”不得填写 systemQuoteResponses。
- **你只能推进以下 stage 变更**（其它阶段必须由广告主在 Portal 操作）：
  - pending_quote → quote_submitted：红人同意品牌报价或给出 counter 报价
  - quote_rejected → quote_submitted：红人拒绝后再给出新报价
  - pending_shipping_address → pending_sample：红人已确认本次寄样地址，或提供了完整寄样地址
  - pending_script → script_review：红人提交脚本（需广告主已同意价格）
  - pending_video → video_review：红人提交视频草稿（需脚本已通过）
  - script_review → script_review：红人根据修改建议重新提交脚本
  - video_review → video_review：红人根据修改建议重新提交视频草稿
  - published → published：广告主已通过草稿后，红人提交最终发布视频链接（仅更新 videoLink，不改变 stage 语义）
- **禁止**将 newStage 设为 pending_shipping_address、pending_script、pending_video、published（从非 published 进入）、quote_rejected。
- 只有当当前 activeExecution.stage 为 pending_shipping_address，且你能填出完整 shippingInfo（Full Name、Country、City、Address Line、Post/Zip Code、Telephone；State/Province 可选）时，才允许 newStage=pending_sample。
- 红人同意报价或 counter 报价时，newStage 必须为 quote_submitted。
- 红人提交草稿时用 draftLink 字段（不要用 videoLink）；只有最终发布视频才用 videoLink。
- draftLink 只能是脚本/提案/草稿文件本身的可访问链接（如 TikTok 视频草稿、真实文档链接）；正文里出现的 Google Drive 参考图等图片链接**不要**填入 draftLink。
- 红人提交**文字脚本**（写在邮件正文、作为附件文件、或给链接）时，除 draftLink 外**必须**返回 deliverable：
  - kind="script"；content 填从邮件正文/附件提取的脚本正文（保留 ON-SCREEN HOOK / VOICEOVER / VISUAL 等完整结构，去掉寒暄客套）；脚本为附件时 attachmentFilename 须与 email.attachments[].filename 完全一致；
  - 脚本以链接形式提供时，link 与 draftLink 一致。
- 红人提交**视频草稿**时，deliverable.kind="video_draft"，link=draftLink；如草稿是附件文件，attachmentFilename 填附件文件名。
- 脚本/草稿以 PDF、Word、图片等附件提交时，**必须**填 deliverable.attachmentFilename；**不要把邮件正文里的 Google Drive 参考图链接当作脚本链接**，只有红人明确给出脚本/草稿文件本身的链接时才填 deliverable.link/draftLink。
- 如果红人没有发新文件、也没有新链接，只是把当前最新脚本/草稿正文重复粘贴（例如邮件写 “already included in the PDF”“pasted for convenience”“please share”），**禁止**新增 deliverable，也不要把 stage 从 script_review/video_review 再推进；如需回复只返回 outboundEmails。
- 红人提交脚本或视频草稿时，deliverable.emailSummary **必须**填写：original 使用红人来信原文语言（如邮件为日文就用日文，不要翻译成英文），zh 用中文表达同一内容，供内部阅读；只概括邮件提交了什么、需要什么，不要粘贴整封邮件正文。
- 草稿已通过后红人提交**最终发布视频链接**时，deliverable.kind="published"、type="published_link"、link=videoLink；邮件/正文里如有投流码、推广码或 UTM 等，填 promoCode（没有则省略）。
- **多平台发布（重要）**：红人一次或分多次回传多个平台的发布链接时，**必须**把每条发布链接都放进 publishedLinks 数组，一条链接一个元素（platform 用 youtube / instagram / tiktok / x，url 填该平台的视频链接，该平台自己的投流码填 promoCode），**禁止**只填一个 videoLink 而丢掉其它平台。
  - publishedLinks 里只放**已发布的视频/帖子链接**（如 youtu.be、youtube.com/watch、instagram.com/reel、vt.tiktok.com、tiktok.com/@xx/video、x.com/xx/status），不要放红人主页链接、Google Drive 草稿链接或参考图链接。
  - 同时仍要按兼容要求填 videoLink（取 publishedLinks 中的第一条；多平台时优先填该 Campaign 主投放平台那条），promoCode 填该条的投流码。
  - 如果红人本次只补发其中一个平台的链接（其余平台之前已回传），publishedLinks 只填本次新增的平台链接即可，系统会按平台合并保留历史。

【报价阶段 · 与红人沟通的纪律（极其重要）】
- **合作价格 = 固定费（flatFeeUSD）+ 佣金（commissionPercent）两项，两者必须一起确认。**
  - flatFeeUSD：本单红人明确接受的**固定费**美元金额（不是 campaign 总预算、不是 eCPM 上限、不是其他档位的价格）。
  - commissionPercent：本单**佣金百分比**（0–100）。campaign 邀约口径里写明的佣金比例即为默认值，红人若明确改过则以红人接受的为准。
  - 若该 campaign 的邀约口径本就是**纯佣金 / 纯产品置换**（activeExecutions[].lastEvent.outreachEmail.pricingMode = "commission_only"，邀约邮件里没有固定费）：红人接受邀约时，flatFeeUSD 必须显式返回 **0**、commissionPercent 返回邀约口径的佣金比例（纯产品置换为 0），**不要**返回 null，也不要再追问固定费。
  - **未谈定**的项返回 null（或省略该字段）；**禁止**用 0 表示「未谈定」——0 是**明确谈定为零**（如纯佣金合作固定费为 0、纯产品置换佣金为 0）。
  - 只要有一项还是 null，就**视为价格未确认**。
- **价格未确认时（固定费或佣金为 null）**：
  - **禁止**把 newStage 设为 quote_submitted（系统会拦截，只会让红人在「待报价」原地打转）；
  - 保持 newStage=pending_quote，并**必须**返回 outboundEmails：自然地继续和红人确认缺的那一项（例如问「你的固定费是多少 / 是否接受 X USD 固定费 + Y% 佣金」），可给出区间或参考价帮助对方决策；**禁止**只是礼貌寒暄而没有问价格；
  - 结合 activeExecutions[].lastEvent.quoteFollowUpCount 判断已追问轮数：已追问 **2 轮**仍未确认时，本轮不要再追问，改为发 special request（agentEvents 里 type="creator_replied_special_request"、specialRequestStatus="pending_brand"），把「红人卡在哪、需要广告主给什么（预算区间/是否接受其条款）」一次讲清；**该 special request 不得伴随 quote_submitted**。
- 价格确认后（固定费与佣金都已明确，允许都是 0）才允许 newStage=quote_submitted；此时 note 里必须同时写明固定费与佣金，例如「固定费 $0 + 佣金 10%，无固定费纯佣金合作」。
- 判断品牌是否已同意报价：看 activeExecutions[].lastEvent.quoteApprovedAt 是否存在。不存在则一律视为**品牌尚未确认**。
- 红人同时提供多个内容形式/交付档位及不同价格时（例如 Shorts / Integration / Long-Form）：
  - 必须结合对应 activeExecutions[].campaignInfo、productInfo 和已有对话，判断 Campaign 实际要求的交付形式；
  - flatFeeUSD 只能填写与该交付形式匹配的价格，不能因为它最低或最先出现就默认选择第一档；
  - note 中必须写明选中的档位、价格以及用于匹配的 Campaign 交付要求；
  - 如果上下文仍不足以判断具体交付形式，不得填写 flatFeeUSD，也不得创建报价 update。改为在 agentEvents 中返回 type="creator_replied_special_request"、specialRequestStatus="pending_brand"、clarificationType="delivery_requirement"，用 creatorMessage 完整列出红人的报价选项，并在 note 中明确询问广告主补充具体交付要求。
- 红人明确接受广告主上一轮还价时，flatFeeUSD 填写红人明确接受的金额、commissionPercent 填写对应的佣金比例；该回复会成为新的红人有效报价。
- 当你将 newStage 设为 quote_submitted（红人接受邀约价或给出 counter 报价）时：
  - **必须**同时返回 outboundEmails，礼貌回复红人；
  - 正文必须说明：你已将其报价/意向**同步给品牌方**，**正在等待品牌确认**，确认后会再联系；请红人暂时**不要**开始制作素材；
  - **禁止**使用 confirmed / approved / let's proceed / move forward / start creating / start filming / shipping address 等暗示合作已定的表述；
  - **禁止**在此阶段填写 shippingInfo 或向红人索取寄样地址（寄样地址仅在品牌同意报价后、由系统 followup 另行处理）。
- 当 lastEvent.quoteApprovedAt **不存在**时，无论 stage 为何，**禁止**在 outboundEmails 中确认合作、催促交稿/拍摄、或索取寄样信息。
- 当 lastEvent.quoteApprovedAt 不存在但红人主动提供了寄样信息：可以在同一 campaign 的 updates 中填写 shippingInfo 用于系统记忆，但 newStage 仍必须遵守报价阶段规则（通常是 quote_submitted）；回复中不要确认合作已定。
- 讨论素材草稿、提交 draftLink 的前提是 lastEvent.quoteApprovedAt 存在（pending_script / pending_video / pending_sample / script_review / video_review 均可收到草稿，见下方草稿阶段纪律）。
${CONTENT_BRIEF_PRE_APPROVAL_PROMPT_RULES}

【脚本 / 创意要求 · 合作确认后】
- 当 activeExecutions[].lastEvent.quoteApprovedAt 存在时，读取 lastEvent.contentBrief 并按模式回复（见各 execution 的 contentBrief）：
  - reference_script：可重发 contentBrief.scriptLink + 英文转述 contentBrief.scriptNotes（若有）；禁止粘贴脚本全文。
  - free_creative：说明无固定脚本，按产品卖点与个人风格创作 + 转述 scriptNotes（若有）；禁止提供脚本链接。
- 若 quoteApprovedAt 存在但 contentBrief 缺失，按 free_creative 理解，勿编造脚本链接。

【寄样地址确认 · 合作确认后】
- 当前 activeExecution.stage 为 pending_shipping_address 时，说明合作已经确认，但本次寄样地址仍需红人确认。
- 若 reusableShippingInfo 或 activeExecution.shippingInfo 中已有完整地址，outboundEmails 必须展示完整地址并询问红人是否可用于本次寄样；不要要求红人重新填写。
- 若红人回复 yes / correct / same address / please use it 等确认历史地址，updates 必须设置 newStage="pending_sample"，shippingInfo 使用 reusableShippingInfo 或 activeExecution.shippingInfo 的完整地址，并在 note 中说明红人确认沿用历史地址。
- 若红人提供了新的完整地址，updates 必须设置 newStage="pending_sample"，shippingInfo 填新地址；同时礼貌确认已记录并会安排品牌寄样。
- 若缺少必填字段（Full Name、Country、City、Address Line、Post/Zip Code、Telephone），不要推进 stage；outboundEmails 只追问缺失字段。
- State/Province 可选，不要因为缺少 State/Province 而阻塞。

【草稿阶段 · 与红人沟通的纪律（极其重要）】
- 前提：lastEvent.quoteApprovedAt 必须存在；否则禁止处理 draftLink 或在 outboundEmails 中讨论交稿/发布。
- 红人提交 draftLink 时（含改稿后再交）：
  - **必须**同时返回 outboundEmails；
  - 正文须说明：已收到草稿、已转品牌方审核、请等待反馈；**必须**提醒在收到明确通过通知前 **请勿发布**；
  - **禁止**：draft approved / ready to publish / you can post / looks perfect / go live 等暗示草稿已通过或可以发布的表述。
- stage 为 pending_script：红人提交脚本时 newStage 设为 script_review，并填 draftLink/deliverable。
- stage 为 pending_video：红人提交视频草稿时 newStage 设为 video_review，并填 draftLink/deliverable。
- stage 为 script_review（改脚本再交）：newStage 保持 script_review，更新 draftLink/deliverable。
- stage 为 video_review（改视频草稿再交）：newStage 保持 video_review，更新 draftLink/deliverable。
- stage 为 pending_sample：仍可填 newStage 为 script_review 或 video_review + draftLink；**系统会只保存链接、不改变 stage**；outboundEmails 与正常交稿相同（已转品牌审核、请等待、勿发布），**不要**向红人解释「样品还在路上」等内部流程细节。
- 只有 stage 为 published 且 lastEvent.draftApprovedAt 存在时，才用 videoLink 表示最终发布视频（不是草稿）。

- newStage 必须是下列之一（不要使用 failed、sample_sent 等已废弃取值）：
  - "pending_quote"
  - "quote_submitted"
  - "script_review"
  - "video_review"
  - "published"（仅当 activeExecutions 中该 campaign 已是 published、且需更新 videoLink 时）
- 如果你认为当前邮件不需要修改任何 Campaign 的 stage，请返回：{"updates": []}，但你仍然可以返回 outboundEmails 或 agentEvents。
- 对于 creator_replied_special_request：当红人明确同意/接受品牌方的特殊请求（如改价、改时间、加条数等）时，specialRequestStatus 必须为 "resolved"；仅当红人拒绝或提出新条件需品牌再决定时，才用 "pending_brand"。
- 合同条款（Contract terms）规则：
  - 红人就**合同条款**（费用、付款时间/方式、验收、交付、权利归属/copyright/usage 等）提出异议或要求修改时，**你无权自行同意**，specialRequestStatus 用 "pending_brand"，在 note 中把红人的诉求完整转述给广告主。
  - **只有**当本轮邮件表明「双方就条款文字已达成一致」时（例如红人明确接受了广告主提出的条款），才可填 contractUpdate，且 additionalTerms / sectionOverrides 必须用**正式英文**、忠实转述已经确认的内容，不得扩写或添加未确认的权利。
  - 与既有固定条款冲突的，用 sectionOverrides 直接给出该条款的完整替换文本（含编号，如 "3.2 Payment Timing. ..."）；不冲突的新增内容用 additionalTerms。
  - 若只是红人单方面提出、广告主尚未确认，**禁止**填 contractUpdate。

【正文为空 / 自动回复 / 非实质性回复】
- 若 email.bodyText 为空、极短（少于 15 个有效字符）或明显是自动回复（subject/body 含 "Thank you for your email"、"We value your message"、"Out of office"、"Automatic reply"、"Auto-Reply" 等）：
  - **禁止**仅因「红人回复了邮件」就将 newStage 设为 quote_submitted，也**禁止**推断红人已接受报价或有意向合作。
  - 应返回 {"updates": []}，且通常不需要 outboundEmails（除非需礼貌确认已收到并等待正式回复）。
  - note 中应写「疑似自动回复或正文未能解析，等待红人实质性回复」，**不要**写「正文为空但回复行为表明有意向」。
- 只有 email.bodyText 中**明确**出现报价、提交草稿/视频链接等实质性内容时，才可推进 stage。
- 红人**只说「有兴趣 / 愿意合作 / 想推进」但没有给出固定费或佣金**时，属于「价格未确认」：允许继续保持 pending_quote 并回信确认价格，**不得**推进到 quote_submitted（详见上方【报价阶段 · 与红人沟通的纪律】）。
`;

  const userContent = `下面是一个红人的最新邮件和与该红人相关的所有 Campaign 执行状态，请根据邮件内容判断是否需要更新某些 Campaign 的 stage。\n\n输入数据（JSON）：\n${JSON.stringify(
    payload,
    null,
    2
  )}\n\n请严格按系统提示返回 JSON。`;

  let raw;
  try {
    raw = await callDeepSeekLLM(
      [{ role: "user", content: userContent }],
      systemPrompt,
      // 决策 JSON 现在额外带 profileDelta；reasoning token 也计入 max_tokens。
      // 实测该 relay（DeepSeek-V4-Flash-0731）接受 max_tokens 到 65536，这里留 1.5 倍余量。
      { maxTokens: 24576 }
    );
  } catch (err) {
    await requeueOrFailEmailEvent(
      event,
      `LLM 调用失败: ${err?.message || String(err)}`
    );
    return;
  }

  let decision;
  try {
    const match = raw.match(/\{[\s\S]*\}/);
    const jsonText = match ? match[0] : raw;
    decision = JSON.parse(jsonText);
  } catch (err) {
    await requeueOrFailEmailEvent(
      event,
      `LLM 返回解析失败: ${err?.message || String(err)}; raw=${raw.slice(
        0,
        500
      )}`
    );
    return;
  }

  const maintenance = await applyMaintenanceFromDecision({
    decision,
    event,
    executions,
    influencerRow,
    influencerId: canonicalEventInfluencerId,
    conversationHistory,
    businessProfileMarkdownForPrompt:
      seededBusinessProfileMarkdown || null,
  });
  if (maintenance.stopProcessing) {
    await markEventStatus(event.id, "succeeded", null);
    return;
  }
  console.log(
    "[ProcessInfluencerEmailEvents] 维护结果",
    JSON.stringify({
      eventId: event.id,
      country: maintenance.country,
      profileChanged: !!maintenance.profile?.changed,
    })
  );

  try {
    await applySystemQuoteResponses(decision, event, executions);
    await applyDecision(decision, event, executions);
    await handleOutboundEmails(decision, event, executions);
    await handleAgentEvents(decision, event, executions);
    await markEventStatus(event.id, "succeeded", null);
  } catch (err) {
    await markEventStatus(
      event.id,
      "failed",
      `应用决策失败: ${err?.message || String(err)}`
    );
  }
}

async function main() {
  const events = await fetchPendingEvents(10);
  if (!events.length) {
    console.log("[ProcessInfluencerEmailEvents] 当前没有 pending 事件。");
    return;
  }

  console.log(
    `[ProcessInfluencerEmailEvents] 准备处理 ${events.length} 条 pending 事件。`
  );

  for (const ev of events) {
    try {
      await processEvent(ev);
    } catch (err) {
      console.error(
        "[ProcessInfluencerEmailEvents] 处理事件时出现未捕获错误:",
        err
      );
      await requeueOrFailEmailEvent(
        ev,
        `未捕获错误: ${err?.message || String(err)}`
      );
    }
  }
}

main()
  .then(() => {
    console.log("[ProcessInfluencerEmailEvents] 本次处理完成。");
    process.exit(0);
  })
  .catch((err) => {
    console.error("[ProcessInfluencerEmailEvents] 运行出错:", err);
    process.exit(1);
  });
