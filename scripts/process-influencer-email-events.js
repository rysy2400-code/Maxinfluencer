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
  markInfluencerDoNotContact,
  updateInfluencerBusinessProfile,
} from "../lib/db/influencer-dao.js";
import {
  isExplicitDoNotContact,
  updateBusinessProfileFromReply,
} from "../lib/influencer/business-profile.js";
import { applySystemQuoteCreatorResponse } from "../lib/billing/refund-system-quote.js";
import { getCampaignById, getExecutionRow } from "../lib/db/campaign-dao.js";
import { enqueueAdvertiserExecutionFollowup } from "../lib/execution/enqueue-advertiser-followup.js";
import { resolveInfluencerThreadMailContext } from "../lib/email/influencer-thread-mail.js";
import {
  isCompleteShippingInfo,
  normalizeShippingInfo,
  resolveReusableShippingInfo,
  upsertInfluencerShippingInfo,
} from "../lib/execution/shipping-info.js";

const AUTO_REPLY_PATTERNS = [
  /thank you for your email/i,
  /we value your message/i,
  /will respond as soon as possible/i,
  /out of office/i,
  /automatic reply/i,
  /auto-?reply/i,
  /away from (my|the) (desk|office)/i,
];

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
    const influencerId = resolveCanonicalInfluencerId({
      requestedInfluencerId: email.influencerId,
      event,
      exec,
    });

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
    }
  }
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

    let videoLink =
      typeof upd.videoLink === "string" && upd.videoLink.trim()
        ? upd.videoLink.trim()
        : null;

    let draftLink =
      typeof upd.draftLink === "string" && upd.draftLink.trim()
        ? upd.draftLink.trim()
        : null;

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

    const payload = {
      type: upd.type || "execution_update_suggested",
      campaignId,
      influencerId: exec.influencerId,
      newStage,
      note: note || "",
      flatFeeUSD: flatFee,
      draftLink,
      videoLink,
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
        draftLink,
        videoLink,
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
  let profileMaintenance = null;
  if (influencerRow && isExplicitDoNotContact(event.body_text)) {
    await markInfluencerDoNotContact({
      influencerId: canonicalEventInfluencerId,
      reason: event.body_text,
      sourceMessageId: event.message_id || null,
    });
    await markEventStatus(event.id, "succeeded", null);
    return;
  }
  if (
    influencerRow &&
    !isLikelyAutoReply(event.subject, event.body_text) &&
    !isBodyEffectivelyEmpty(event.body_text)
  ) {
    try {
      profileMaintenance = await updateBusinessProfileFromReply({
        influencer: influencerRow,
        email: {
          subject: event.subject || "",
          bodyText: event.body_text || "",
          messageId: event.message_id || null,
          receivedAt: event.received_at || event.created_at || null,
        },
        conversationHistory,
      });
      if (profileMaintenance?.doNotContact) {
        await markInfluencerDoNotContact({
          influencerId: canonicalEventInfluencerId,
          reason: profileMaintenance.doNotContactReason || event.body_text,
          sourceMessageId: event.message_id || null,
        });
        await markEventStatus(event.id, "succeeded", null);
        return;
      }
      if (profileMaintenance?.changed && profileMaintenance.profileMarkdown) {
        await updateInfluencerBusinessProfile({
          influencerId: canonicalEventInfluencerId,
          markdown: profileMaintenance.profileMarkdown,
          sourceMessageId: event.message_id || null,
        });
      }
    } catch (err) {
      console.warn(
        "[ProcessInfluencerEmailEvents] 商务档案更新失败:",
        err?.message || err
      );
    }
  }
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
    threadInfo: {
      canonicalThreadSubject: threadMailCtx.canonicalBase,
      rootMessageId: threadMailCtx.rootMessageId,
      parentMessageId: threadMailCtx.parentMessageId,
      suggestedSubjectForReply: threadMailCtx.subjectForSend,
    },
    profileMaintenance,
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

【当前任务：处理红人邮件事件并给出业务决策】
- 你正收到一封红人发来的最新邮件（email），你还可以看到：
  - conversationHistory：你与该红人的历史对话记录；
  - activeExecutions：该红人在各个 campaign 下当前的执行状态；
  - threadInfo：规范化线程标题（canonicalThreadSubject）、根/父 Message-ID、以及建议的续信标题（suggestedSubjectForReply，通常为 Re: + 规范化标题）。
- 你的目标是：在尊重红人体验的前提下，做出合理的业务决策，并通过结构化 JSON 告诉系统要做什么。
- profileMaintenance.questions 若非空，须在正常业务回复结尾自然询问这些缺失或待确认项目；不要重复询问已有信息。

输入 JSON 中包含：
- email：当前这封邮件的关键信息；
- activeExecutions：该红人当前所有相关执行记录；
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
        "draftLink": "https://www.tiktok.com/@xxx/video/123",
        "videoLink": "https://www.tiktok.com/@xxx/video/456",
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
        "note": "用简明中文总结红人态度和关键信息，方便执行侧阅读"
      }
    ],
    "systemQuoteResponses": [
      {
        "campaignId": "CAMP-xxx",
        "response": "accepted|declined|countered",
        "newAmountUsd": 800,
        "note": "红人对系统建议合作和价格的明确回复摘要"
      }
    ]
  }

- updates 会被写入 tiktok_advertiser_agent_event，由后台 worker 落库；**stage 变更受状态机约束**，越权变更会被拦截，但报价/寄样/草稿/视频链接等字段仍可能写入。
- activeExecutions 中 stage=pending_creator_confirmation 时，只能在红人明确接受、拒绝或提出新价格后填写 systemQuoteResponses。不要同时为同一 campaign 填 updates。
- 填写 systemQuoteResponses 后不要再为该 campaign 生成 outboundEmails；系统会按最终状态发送下一步邮件，拒绝或新报价则无需自动回复。
- 红人接受时 response=accepted；拒绝时 response=declined；提出不同价格时 response=countered，并将外币报价合理估算为 USD 后填 newAmountUsd。
- 含糊回复、自动回复或“稍后答复”不得填写 systemQuoteResponses。
- **你只能推进以下 stage 变更**（其它阶段必须由广告主在 Portal 操作）：
  - pending_quote → quote_submitted：红人同意品牌报价或给出 counter 报价
  - quote_rejected → quote_submitted：红人拒绝后再给出新报价
  - pending_shipping_address → pending_sample：红人已确认本次寄样地址，或提供了完整寄样地址
  - pending_draft → draft_submitted：红人提交素材草稿（需广告主已同意价格）
  - draft_submitted → draft_submitted：红人根据修改建议重新提交草稿
  - published → published：广告主已通过草稿后，红人提交最终发布视频链接（仅更新 videoLink，不改变 stage 语义）
- **禁止**将 newStage 设为 pending_shipping_address、pending_draft、published（从非 published 进入）、quote_rejected。
- 只有当当前 activeExecution.stage 为 pending_shipping_address，且你能填出完整 shippingInfo（Full Name、Country、City、Address Line、Post/Zip Code、Telephone；State/Province 可选）时，才允许 newStage=pending_sample。
- 红人同意报价或 counter 报价时，newStage 必须为 quote_submitted。
- 红人提交草稿时用 draftLink 字段（不要用 videoLink）；只有最终发布视频才用 videoLink。
- draftLink 可以是 TikTok、Google Drive、Dropbox、Box、WeTransfer、MediaFire、iCloud 等任意可访问链接；从正文/附件识别到链接时务必填入 draftLink（published 阶段交最终稿除外，才用 videoLink）。

【报价阶段 · 与红人沟通的纪律（极其重要）】
- 判断品牌是否已同意报价：看 activeExecutions[].lastEvent.quoteApprovedAt 是否存在。不存在则一律视为**品牌尚未确认**。
- 红人同时提供多个内容形式/交付档位及不同价格时（例如 Shorts / Integration / Long-Form）：
  - 必须结合对应 activeExecutions[].campaignInfo、productInfo 和已有对话，判断 Campaign 实际要求的交付形式；
  - flatFeeUSD 只能填写与该交付形式匹配的价格，不能因为它最低或最先出现就默认选择第一档；
  - note 中必须写明选中的档位、价格以及用于匹配的 Campaign 交付要求；
  - 如果上下文仍不足以判断具体交付形式，不得填写 flatFeeUSD，也不得创建报价 update。改为在 agentEvents 中返回 type="creator_replied_special_request"、specialRequestStatus="pending_brand"、clarificationType="delivery_requirement"，用 creatorMessage 完整列出红人的报价选项，并在 note 中明确询问广告主补充具体交付要求。
- 红人明确接受广告主上一轮还价时，flatFeeUSD 填写红人明确接受的金额；该回复会成为新的红人有效报价。
- 当你将 newStage 设为 quote_submitted（红人接受邀约价或给出 counter 报价）时：
  - **必须**同时返回 outboundEmails，礼貌回复红人；
  - 正文必须说明：你已将其报价/意向**同步给品牌方**，**正在等待品牌确认**，确认后会再联系；请红人暂时**不要**开始制作素材；
  - **禁止**使用 confirmed / approved / let's proceed / move forward / start creating / start filming / shipping address 等暗示合作已定的表述；
  - **禁止**在此阶段填写 shippingInfo 或向红人索取寄样地址（寄样地址仅在品牌同意报价后、由系统 followup 另行处理）。
- 当 lastEvent.quoteApprovedAt **不存在**时，无论 stage 为何，**禁止**在 outboundEmails 中确认合作、催促交稿/拍摄、或索取寄样信息。
- 当 lastEvent.quoteApprovedAt 不存在但红人主动提供了寄样信息：可以在同一 campaign 的 updates 中填写 shippingInfo 用于系统记忆，但 newStage 仍必须遵守报价阶段规则（通常是 quote_submitted）；回复中不要确认合作已定。
- 讨论素材草稿、提交 draftLink 的前提是 lastEvent.quoteApprovedAt 存在（pending_draft / pending_sample / draft_submitted 均可收到草稿，见下方草稿阶段纪律）。
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
- stage 为 pending_draft：newStage 设为 draft_submitted，并填 draftLink。
- stage 为 draft_submitted（改稿再交）：newStage 保持 draft_submitted，更新 draftLink。
- stage 为 pending_sample：仍可填 newStage 为 draft_submitted + draftLink；**系统会只保存链接、不改变 stage**；outboundEmails 与正常交稿相同（已转品牌审核、请等待、勿发布），**不要**向红人解释「样品还在路上」等内部流程细节。
- 只有 stage 为 published 且 lastEvent.draftApprovedAt 存在时，才用 videoLink 表示最终发布视频（不是草稿）。

- newStage 必须是下列之一（不要使用 failed、sample_sent 等已废弃取值）：
  - "pending_quote"
  - "quote_submitted"
  - "draft_submitted"
  - "published"（仅当 activeExecutions 中该 campaign 已是 published、且需更新 videoLink 时）
- 如果你认为当前邮件不需要修改任何 Campaign 的 stage，请返回：{"updates": []}，但你仍然可以返回 outboundEmails 或 agentEvents。
- 对于 creator_replied_special_request：当红人明确同意/接受品牌方的特殊请求（如改价、改时间、加条数等）时，specialRequestStatus 必须为 "resolved"；仅当红人拒绝或提出新条件需品牌再决定时，才用 "pending_brand"。

【正文为空 / 自动回复 / 非实质性回复】
- 若 email.bodyText 为空、极短（少于 15 个有效字符）或明显是自动回复（subject/body 含 "Thank you for your email"、"We value your message"、"Out of office"、"Automatic reply"、"Auto-Reply" 等）：
  - **禁止**仅因「红人回复了邮件」就将 newStage 设为 quote_submitted，也**禁止**推断红人已接受报价或有意向合作。
  - 应返回 {"updates": []}，且通常不需要 outboundEmails（除非需礼貌确认已收到并等待正式回复）。
  - note 中应写「疑似自动回复或正文未能解析，等待红人实质性回复」，**不要**写「正文为空但回复行为表明有意向」。
- 只有 email.bodyText 中**明确**出现报价、同意合作、提交草稿/视频链接等实质性内容时，才可推进 stage。
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
      systemPrompt
    );
  } catch (err) {
    await markEventStatus(
      event.id,
      "failed",
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
    await markEventStatus(
      event.id,
      "failed",
      `LLM 返回解析失败: ${err?.message || String(err)}; raw=${raw.slice(
        0,
        500
      )}`
    );
    return;
  }

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
      await markEventStatus(
        ev.id,
        "failed",
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
