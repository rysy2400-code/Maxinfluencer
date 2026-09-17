/**
 * Worker：消费 tiktok_influencer_agent_event，作为 InfluencerAgent 统一负责对红人的所有发信动作。
 *
 * 职责（MVP）：
 * - 处理 first_outreach 事件：调用 sendOutreach 发首封邀约邮件；
 * - 处理 outbound_email 事件：根据 payload 中的信息直接发邮件给红人，并写入对话记忆表。
 * - 处理 advertiser_execution_followup：广告主 Portal 操作（同意/拒绝/还价价格、寄样、草稿）后的跟进邮件。
 *
 * 使用方式（示例）：
 *   node scripts/process-influencer-agent-events.js
 */

import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { queryTikTok } from "../lib/db/mysql-tiktok.js";
import { getInfluencerById } from "../lib/db/influencer-dao.js";
import { getCampaignById, getExecutionRow } from "../lib/db/campaign-dao.js";
import {
  sendOutreach,
  loadConversationHistoryForInfluencer,
} from "../lib/agents/influencer-agent.js";
import { sendMail, OutboundCooldownError } from "../lib/email/enterprise-mail-client.js";
import { resolveInfluencerThreadMailContext } from "../lib/email/influencer-thread-mail.js";
import { logConversationMessage } from "../lib/db/influencer-conversation-dao.js";
import { normalizeCanonicalInfluencerId } from "../lib/influencer/influencer-id-resolver.js";
import { getInfluencerHandoverMode } from "../lib/db/influencer-handover-dao.js";
import { logDraftOutboundMessage } from "../lib/db/influencer-draft-dao.js";
import {
  attachOutboundAttachmentsToConversationMessage,
  getOutboundAttachmentById,
  insertOutboundAttachment,
} from "../lib/db/influencer-outbound-attachments-dao.js";
import { readSessionImportFile } from "../lib/influencer/session-import-storage.js";
import { normalizeAttachmentContentType } from "../lib/influencer/attachment-file-types.js";
import { callDeepSeekLLM } from "../lib/utils/llm-client.js";
import { influencerAgentBasePrompt } from "../lib/agents/influencer-agent-prompt.js";
import {
  resolveCommunicationLanguage,
  languageEnglishName,
} from "../lib/influencer/infer-bio-language.js";
import { languageDisplayName } from "../lib/influencer/country-primary-language.js";
import { getInfluencerLanguage } from "../lib/influencer/influencer-language-store.js";
import { generateAdvertiserExecutionFollowupEmailBody } from "../lib/agents/advertiser-execution-followup-email.js";
import {
  SHIPPING_MENTION_ACTIONS,
  containsForbiddenAddressConfirm,
  containsForbiddenShippingConfirm,
} from "../lib/execution/followup-shipping-guard.js";
import {
  buildTraceIdFromInboundMessageId,
  buildTraceIdFromSourceKey,
} from "../lib/utils/timeline-ids.js";
import {
  generateContractForExecution,
  resolveContractAbsPath,
} from "../lib/contract/generate-contract.js";
import { generateContractEmailBody } from "../lib/contract/contract-email.js";
import { buildContractClauses } from "../lib/contract/contract-clauses.js";

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

/**
 * 生成跟进邮件正文；发送前兜底：
 * - 非寄样动作（approveDraft 等）：误含“确认地址/样品即将寄出”内容 → 追加禁令重写一次；
 * - confirmShip：只通知已寄出，误含“确认地址”内容 → 追加禁令重写一次；
 * 仍违规则抛错拦截发送。
 *
 * @param {{ action: string, [key: string]: unknown }} opts
 * @param {{ generateBody?: typeof generateAdvertiserExecutionFollowupEmailBody }} deps 测试用依赖注入
 */
export async function generateAdvertiserFollowupBody(opts, deps = {}) {
  const { action, ...generatorArgs } = opts;
  const generateBody =
    deps.generateBody || generateAdvertiserExecutionFollowupEmailBody;
  // 关键：action 决定正文的任务语义（approve/reject/counter/寄样等），
  // 必须原样透传给 generateAdvertiserExecutionFollowupEmailBody。
  let bodyText = await generateBody({ ...generatorArgs, action });
  const shippingMentionAllowed = SHIPPING_MENTION_ACTIONS.has(action);
  let violation = false;
  let extraInstruction = "";
  if (!shippingMentionAllowed) {
    violation = containsForbiddenShippingConfirm(bodyText);
    extraInstruction =
      "上一版误加入了寄样/地址确认内容。本次动作与寄样无关（样品可能已寄出），请重写并完全删除任何关于寄样、发货、收件地址或地址确认的内容，不要出现 shipping address / confirm address / shipment / about to go out 等表述。";
  } else if (action === "confirmShip") {
    violation = containsForbiddenAddressConfirm(bodyText);
    extraInstruction =
      "上一版误让红人确认寄样地址。本次动作只通知样品已寄出，请重写并删除任何收件地址展示或地址确认内容，不要出现 shipping address / confirm address / 收件地址等表述。";
  }
  if (violation) {
    console.warn(
      `[ProcessInfluencerAgentEvents] ${action} 的跟进邮件误含寄样/地址确认内容，追加禁令重新生成…`
    );
    bodyText = await generateBody({
      ...generatorArgs,
      action,
      extraInstruction,
    });
    const stillViolation = shippingMentionAllowed
      ? containsForbiddenAddressConfirm(bodyText)
      : containsForbiddenShippingConfirm(bodyText);
    if (stillViolation) {
      throw new Error(
        `跟进邮件（action=${action}）重写后仍包含禁止的寄样地址确认内容，已拦截发送以防误发。`
      );
    }
  }
  return bodyText;
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
dotenv.config({ path: path.join(projectRoot, ".env") });
dotenv.config({ path: path.join(projectRoot, ".env.local") });

/** 与 tiktok_influencer.influencer_id 一致的平台 userId；Worker 单文件内联，避免未合并的 campaign-dao 依赖 */
async function getExecutionPlatformInfluencerId(campaignId, tiktokUsername) {
  if (!campaignId || tiktokUsername == null) return null;
  const h = String(tiktokUsername).replace(/^@/, "").trim();
  if (!h) return null;
  const rows = await queryTikTok(
    `
    SELECT influencer_id
    FROM tiktok_campaign_execution
    WHERE campaign_id = ? AND tiktok_username = ?
    LIMIT 1
  `,
    [campaignId, h]
  );
  const v = rows?.[0]?.influencer_id;
  return v != null && String(v).trim() !== "" ? String(v).trim() : null;
}

/** 事务型/高优先级事件（与批量 first_outreach 分流消费） */
export const TRANSACTIONAL_AGENT_EVENT_TYPES = [
  "advertiser_execution_followup",
  "ask_influencer_special_request",
  "send_contract_email",
  "outbound_email",
];

/** 批量首封邀约，允许排队等待 */
export const OUTREACH_AGENT_EVENT_TYPES = ["first_outreach"];

const AGENT_EVENT_MODE_VALUES = new Set(["all", "urgent", "outreach"]);

/**
 * 解析当前进程消费模式：
 * - urgent：只消费 advertiser_execution_followup / ask_influencer_special_request / outbound_email；
 * - outreach：只消费 first_outreach；
 * - all：兼容旧调用，消费全部事件（同一张表里不应同时常驻 all 与 urgent/outreach，避免重复消费）。
 */
export function resolveAgentEventMode() {
  const argMode = (process.argv || [])
    .find((a) => a.startsWith("--mode="))
    ?.split("=")[1]
    ?.trim()
    .toLowerCase();
  const envMode = String(process.env.INFLUENCER_AGENT_EVENT_MODE || "")
    .trim()
    .toLowerCase();
  const mode = argMode || envMode || "all";
  if (!AGENT_EVENT_MODE_VALUES.has(mode)) {
    console.warn(
      `[ProcessInfluencerAgentEvents] 未知 mode="${mode}"，回退 all。`
    );
    return "all";
  }
  return mode;
}

function eventTypesForMode(mode) {
  if (mode === "urgent") return TRANSACTIONAL_AGENT_EVENT_TYPES;
  if (mode === "outreach") return OUTREACH_AGENT_EVENT_TYPES;
  return null; // all
}

/**
 * 原子认领 pending 事件：先取候选 ID，再逐条用
 * `WHERE id=? AND status='pending'` 条件更新为 processing。
 * 两个消费进程同时运行时，同一事件只会有一个进程更新成功，避免重复发信。
 */
async function fetchPendingInfluencerAgentEvents(limit = 20, mode = "all") {
  const n = Math.min(50, Math.max(1, Number(limit) || 20));
  const types = eventTypesForMode(mode);
  const typeSql = types?.length
    ? `AND event_type IN (${types.map(() => "?").join(",")})`
    : "";
  const selectParams = types?.length ? [...types] : [];

  const candidates = await queryTikTok(
    `
    SELECT id
    FROM tiktok_influencer_agent_event
    WHERE status = 'pending'
      ${typeSql}
    ORDER BY created_at ASC
    LIMIT ${n}
  `,
    selectParams
  );

  const claimedIds = [];
  for (const row of candidates || []) {
    const upd = await queryTikTok(
      `
      UPDATE tiktok_influencer_agent_event
      SET status = 'processing', updated_at = NOW()
      WHERE id = ? AND status = 'pending'
    `,
      [row.id]
    );
    if (Number(upd?.affectedRows || 0) > 0) claimedIds.push(row.id);
  }

  if (!claimedIds.length) return [];
  const idPlaceholders = claimedIds.map(() => "?").join(",");
  const rows = await queryTikTok(
    `
    SELECT *
    FROM tiktok_influencer_agent_event
    WHERE id IN (${idPlaceholders})
    ORDER BY created_at ASC, id ASC
  `,
    claimedIds
  );
  return rows || [];
}

/**
 * 只认领并返回指定 id 的 pending 事件（用于人工定向补发，避免顺带消费其它事件）。
 * --force-claim：接管已被置为 processing 的事件（人工补发前先 hold，避免其它 worker 抢先）。
 */
const ALLOW_FORCE_CLAIM = process.argv.includes("--force-claim");

async function claimInfluencerAgentEventById(id) {
  const eventId = Number(id);
  if (!Number.isFinite(eventId) || eventId <= 0) return null;
  const upd = await queryTikTok(
    `
    UPDATE tiktok_influencer_agent_event
    SET status = 'processing', updated_at = NOW()
    WHERE id = ? AND status = 'pending'
    `,
    [eventId]
  );
  if (Number(upd?.affectedRows || 0) === 0) {
    if (!ALLOW_FORCE_CLAIM) return null;
    const takeover = await queryTikTok(
      `
      UPDATE tiktok_influencer_agent_event
      SET status = 'processing', updated_at = NOW()
      WHERE id = ?
    `,
      [eventId]
    );
    if (Number(takeover?.affectedRows || 0) === 0) return null;
  }
  const rows = await queryTikTok(
    `SELECT * FROM tiktok_influencer_agent_event WHERE id = ? LIMIT 1`,
    [eventId]
  );
  return rows?.[0] || null;
}

/** 解析 --event-id <id> / AGENT_EVENT_ID，用于定向补发单条事件 */
function resolveOnlyEventId() {
  const i = process.argv.indexOf("--event-id");
  const raw = i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : process.env.AGENT_EVENT_ID;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function looksLikeNumericPlatformId(v) {
  return v != null && /^\d{10,}$/.test(String(v).trim());
}

/**
 * 解析 TikTok 平台 userId（与 tiktok_influencer.influencer_id 一致），不用 username 查主档。
 */
async function resolvePlatformInfluencerIdForAgentEvent(campaignId, eventRow, payload) {
  if (payload?.platformInfluencerId != null && String(payload.platformInfluencerId).trim() !== "") {
    return String(payload.platformInfluencerId).trim();
  }
  const ev = eventRow?.influencer_id;
  if (ev != null && String(ev).trim() !== "") {
    const s = String(ev).trim();
    if (looksLikeNumericPlatformId(s)) return s;
  }
  const cand = payload?.influencerId;
  if (cand != null && looksLikeNumericPlatformId(cand)) return String(cand).trim();
  const handle = payload?.tiktokUsername || payload?.influencerHandle || cand;
  if (campaignId && handle) {
    const fromExec = await getExecutionPlatformInfluencerId(
      campaignId,
      String(handle).replace(/^@/, "").trim()
    );
    if (fromExec) return fromExec;
  }
  if (campaignId && ev != null && String(ev).trim() !== "" && !looksLikeNumericPlatformId(ev)) {
    return (
      (await getExecutionPlatformInfluencerId(
        campaignId,
        String(ev).replace(/^@/, "").trim()
      )) || null
    );
  }
  return null;
}

async function markInfluencerAgentEventStatus(
  id,
  status,
  errorMessage = null,
  senderEmail = null
) {
  await queryTikTok(
    `
    UPDATE tiktok_influencer_agent_event
    SET status = ?, error_message = ?,
        payload = CASE WHEN ? IS NULL THEN payload ELSE JSON_SET(
          COALESCE(payload, JSON_OBJECT()), '$.deliveryAudit',
          JSON_OBJECT('senderEmail', ?)
        ) END,
        updated_at = NOW()
    WHERE id = ?
  `,
    [status, errorMessage, senderEmail, senderEmail, id]
  );
}

async function sendOrDraftAgentEmail({
  influencerId,
  campaignId = null,
  fromAccount,
  toEmail,
  subject,
  bodyText,
  headers,
  sourceType,
  sourceEventId,
  triggerType,
  traceId,
  emailPayload = {},
  payload = {},
  attachments = null,
  attachmentMetas = [],
}) {
  const fromEmail =
    fromAccount.email ||
    fromAccount.email_address ||
    fromAccount.username ||
    fromAccount.account ||
    null;
  const handoverMode = (await getInfluencerHandoverMode(influencerId)) || "auto";
  const normalizedAttachmentMetas = Array.isArray(attachmentMetas)
    ? attachmentMetas.filter((a) => a?.fileName || a?.storageKey)
    : [];

  if (handoverMode === "assist") {
    await logDraftOutboundMessage({
      influencerId,
      campaignId,
      fromEmail,
      toEmail,
      subject,
      bodyText,
      sourceType,
      sourceEventTable: "tiktok_influencer_agent_event",
      sourceEventId,
      triggerType,
      traceId,
      payload: {
        ...payload,
        ...(normalizedAttachmentMetas.length
          ? {
              attachments: {
                source: "outbound_attachments",
                items: normalizedAttachmentMetas,
              },
            }
          : {}),
        email: {
          to: toEmail,
          subject,
          inReplyTo: emailPayload.inReplyTo || null,
          ...(payload.email || {}),
        },
        source: {
          eventTable: "tiktok_influencer_agent_event",
          eventId: sourceEventId,
          triggerType,
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
      ...(Array.isArray(attachments) && attachments.length
        ? { attachments }
        : {}),
    });
  } catch (err) {
    sendErr = err;
  }
  return { drafted: false, fromEmail, result, sendErr };
}

async function handleFirstOutreach(eventRow, payload) {
  const campaignId = payload.campaignId || eventRow.campaign_id;
  const tiktokUsername = String(
    payload.tiktokUsername || payload.influencerId || ""
  )
    .replace(/^@/, "")
    .trim();
  const snapshot = payload.snapshot || null;

  if (!campaignId || !tiktokUsername) {
    throw new Error(
      "first_outreach 缺少必要字段：campaignId / tiktokUsername（或旧 payload.influencerId=handle）"
    );
  }

  let platformId =
    payload.platformInfluencerId != null &&
    String(payload.platformInfluencerId).trim() !== ""
      ? String(payload.platformInfluencerId).trim()
      : "";

  if (!platformId) {
    const fromExec = await getExecutionPlatformInfluencerId(campaignId, tiktokUsername);
    if (fromExec) platformId = fromExec;
  }

  if (!platformId && eventRow.influencer_id != null && String(eventRow.influencer_id).trim() !== "") {
    const ev = String(eventRow.influencer_id).trim();
    const mainRow = await getInfluencerById(ev);
    if (mainRow) platformId = ev;
  }

  if (!platformId) {
    throw new Error(
      "first_outreach 缺少平台 influencer_id：请回填 tiktok_campaign_execution.influencer_id，或在 payload 提供 platformInfluencerId（须与 tiktok_influencer.influencer_id 一致）"
    );
  }

  await sendOutreach({
    campaignId,
    platformInfluencerId: platformId,
    tiktokUsername,
    platform: payload.platform || snapshot?.platform || snapshot?.platformSlug || null,
    snapshot,
    sourceEventId: eventRow.id,
  });
}

async function handleOutboundEmail(eventRow, payload) {
  const campaignId = payload.campaignId || eventRow.campaign_id || null;
  const platformInfluencerId = await resolvePlatformInfluencerIdForAgentEvent(
    campaignId,
    eventRow,
    payload
  );
  // 统一归一化成平台 influencer_id，禁止 handle/用户名落库
  const influencerId =
    platformInfluencerId ||
    (await normalizeCanonicalInfluencerId(
      payload.influencerId || eventRow.influencer_id
    )) ||
    null;

  const to =
    payload.to ||
    payload.toEmail ||
    (payload.emailEvent && payload.emailEvent.fromEmail) ||
    null;
  const body = payload.body || payload.bodyText || "";

  if (!to) {
    throw new Error("outbound_email 缺少收件人 to");
  }

  let influencer = null;
  if (platformInfluencerId) {
    try {
      influencer = await getInfluencerById(platformInfluencerId);
    } catch {
      influencer = null;
    }
  }

  const ctx = await resolveInfluencerThreadMailContext({
    influencerId: platformInfluencerId || influencerId,
    influencer,
    preferredInReplyToMessageId:
      payload.inReplyTo || payload.emailEvent?.messageId || null,
  });
  const fromAccount = ctx.fromAccount;
  const subject =
    (payload.subject && String(payload.subject).trim()) ||
    ctx.subjectForSend;

  const headers = {
    "X-Maxin-Influencer-Id": platformInfluencerId || "",
    "X-Maxin-Campaign-Id": campaignId || "",
    "X-Maxin-Source": "InfluencerAgent",
  };
  if (ctx.inReplyTo) {
    headers["In-Reply-To"] = ctx.inReplyTo;
  }
  if (ctx.references) {
    headers["References"] = ctx.references;
  }

  const inboundMessageId =
    payload.inReplyTo || payload.emailEvent?.messageId || null;
  const traceId = inboundMessageId
    ? buildTraceIdFromInboundMessageId(inboundMessageId)
    : buildTraceIdFromSourceKey(`influencer_agent_event:${eventRow.id}`);

  const delivery = await sendOrDraftAgentEmail({
    influencerId: platformInfluencerId || influencerId,
    campaignId,
    fromAccount,
    toEmail: to,
    subject,
    bodyText: body,
    headers,
    sourceType: payload.sourceType || "outbound_email",
    sourceEventId: eventRow.id,
    triggerType: "outbound_email",
    traceId,
    emailPayload: { inReplyTo: inboundMessageId },
  });
  if (delivery.drafted) return;
  const { result, sendErr, fromEmail } = delivery;

  // 记录到对话记忆表
  try {
    await logConversationMessage({
      influencerId: platformInfluencerId || influencerId,
      campaignId,
      direction: "bin",
      channel: "email",
      fromEmail,
      toEmail: to,
      subject,
      bodyText: body,
      messageId: result?.messageId || null,
      sourceType: payload.sourceType || "outbound_email",
      sourceEventTable: "tiktok_influencer_agent_event",
      sourceEventId: eventRow.id,
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
        source: {
          eventTable: "tiktok_influencer_agent_event",
          eventId: eventRow.id,
        },
      },
    });
  } catch (err) {
    console.error(
      "[ProcessInfluencerAgentEvents] 写入 tiktok_influencer_conversation_messages 失败:",
      err
    );
  }

  if (sendErr) {
    throw sendErr;
  }
}

async function handleAskInfluencerSpecialRequest(eventRow, payload) {
  const campaignId = payload.campaignId || eventRow.campaign_id || null;
  const specialRequestId = payload.specialRequestId || null;
  const specialRequestStatus = payload.specialRequestStatus || "pending_creator";
  const brandMessage = payload.brandMessage || "";

  // 解析随信资料附件（PDF / Word / PPT / 图片）：storageKey 指向 data/session-imports（与 Web 同机，worker 可直接读取）
  const rawAttachments = Array.isArray(payload.attachments) ? payload.attachments : [];
  const attachmentMetas = [];
  const nodemailerAttachments = [];
  for (let idx = 0; idx < rawAttachments.length; idx++) {
    const att = rawAttachments[idx] || {};
    const storageKey = String(att.storageKey || "").trim();
    const fileName = String(att.fileName || "").trim();
    const outboundAttachmentId = Number(att.outboundAttachmentId) || null;
    if (!fileName || (!storageKey && !outboundAttachmentId)) continue;
    // 附件内容优先从库里取：上传在 Web 机器，发信 worker 在另一台机器，
    // 直接读本地 data/session-imports 会读不到（历史故障根源）。
    let buffer = null;
    if (outboundAttachmentId) {
      const row = await getOutboundAttachmentById(outboundAttachmentId);
      const content = row?.content;
      if (Buffer.isBuffer(content)) buffer = content;
      else if (content) buffer = Buffer.from(content);
    }
    if (!buffer?.length && storageKey) buffer = readSessionImportFile(storageKey);
    if (!buffer?.length) {
      throw new Error(
        `ask_influencer_special_request 附件「${fileName}」不存在或读取失败（outboundAttachmentId=${outboundAttachmentId || "无"}，storageKey=${storageKey || "无"}）`
      );
    }
    const contentType = normalizeAttachmentContentType(fileName, att.contentType);
    const sizeBytes =
      typeof att.sizeBytes === "number" && Number.isFinite(att.sizeBytes)
        ? att.sizeBytes
        : buffer.length;
    attachmentMetas.push({
      fileName,
      storageKey,
      contentType,
      sizeBytes,
      ...(outboundAttachmentId ? { outboundAttachmentId } : {}),
      ...(att.outboundDedupeKey
        ? { outboundDedupeKey: String(att.outboundDedupeKey) }
        : {}),
    });
    nodemailerAttachments.push({ filename: fileName, contentType, content: buffer });
  }
  const attachmentNames = attachmentMetas.map((a) => a.fileName).filter(Boolean);

  const platformInfluencerId = await resolvePlatformInfluencerIdForAgentEvent(
    campaignId,
    eventRow,
    payload
  );
  if (!platformInfluencerId) {
    throw new Error(
      "ask_influencer_special_request 无法解析平台 influencer_id（请使用 payload.platformInfluencerId 或执行行已回填）"
    );
  }

  const influencer = await getInfluencerById(platformInfluencerId);
  if (!influencer) {
    throw new Error(
      `ask_influencer_special_request 主档不存在红人 influencer_id=${platformInfluencerId}`
    );
  }

  const toEmail =
    typeof influencer.influencerEmail === "string" &&
    influencer.influencerEmail.includes("@")
      ? influencer.influencerEmail.trim()
      : null;

  if (!toEmail) {
    throw new Error(
      `ask_influencer_special_request 红人 influencer_id=${platformInfluencerId} 缺少邮箱联系方式`
    );
  }

  // 对话历史（红人全局，跨 campaign）
  const conversationHistory = await loadConversationHistoryForInfluencer(
    platformInfluencerId,
    20
  );

  const ctx = await resolveInfluencerThreadMailContext({
    influencerId: platformInfluencerId,
    influencer,
    campaignId,
  });
  const fromAccount = ctx.fromAccount;

  // 发信语言：红人最近一次回复语言 > bio 语言（置信度过线）> 英语
  const languageRecord = await getInfluencerLanguage(platformInfluencerId).catch(
    (err) => {
      console.warn(
        "[InfluencerAgentEvents] 读取红人沟通语言失败（按英语兜底）:",
        err?.message || err
      );
      return null;
    }
  );
  const outboundLanguage = resolveCommunicationLanguage({
    replyLanguage: languageRecord?.communicationLanguage || null,
    bioLanguage: languageRecord?.bioLanguage || null,
    bioLanguageConfidence: languageRecord?.bioLanguageConfidence ?? null,
  });
  const outboundLanguageEn = languageEnglishName(outboundLanguage.language);
  const outboundLanguageZh = languageDisplayName(outboundLanguage.language);

  const systemPrompt = `
${influencerAgentBasePrompt}

【当前任务：向红人转达品牌的「特殊请求」，并询问红人是否接受】
- 你现在要给指定红人写一封邮件，内容是转达品牌方/执行侧的一个「特殊请求」。
- **发信语言（必须）**：用${outboundLanguageZh}（${outboundLanguageEn}）写正文；这是该红人的沟通语言（来源：${outboundLanguage.source === "reply" ? "红人最近一次回复语言" : outboundLanguage.source === "bio" ? "红人主页简介语言" : "默认英语"}）。品牌名、产品名、链接、文件名保留原文。
- specialRequestId 表示这一轮特殊请求会话的唯一 ID，你可以在心里当作标签，用于保持这轮沟通的一致性，但不需要在邮件里直接写出 ID。
- 本轮对应的 campaignId 为 ${campaignId || "null"}；若 conversationHistory 涉及多个 campaign，你必须在正文中自然区分，避免混淆。
- brandMessage 是品牌/执行侧给你的自然语言说明，你需要用自己的话把它转述给红人。
- 随邮件附带的资料附件：${attachmentNames.length ? attachmentNames.join("、") : "（无）"}。若有附件，正文必须自然提及（例如「请查收随附的 xxx.pdf」「图片见附件」），并简要说明附件用途（按 brandMessage 提供的信息）；不要写「见附件」而没有文件名。
- 语气：专业、友好、简洁，像一对一沟通，而不是群发模板。
- 要清楚地告诉红人：品牌方希望他/她确认是否愿意按这个请求执行（例如改时间、改脚本、多加一条内容并增加预算等），并邀请红人表达自己的想法或修改意见。
- 可以根据 conversationHistory 判断目前合作进展，适当提及之前的沟通，但不要重复上一封几乎一模一样的句子。
- 只输出${outboundLanguageEn}邮件正文（纯文本，不要 markdown，不要 JSON，不要额外解释）。`;

  const payloadForLLM = {
    influencer: {
      id: influencer.influencerId || influencer.id || null,
      displayName: influencer.displayName || null,
      username: influencer.username || null,
      profileUrl: influencer.profileUrl || null,
      country: influencer.country || null,
    },
    campaignId,
    specialRequestId,
    specialRequestStatus,
    brandMessage,
    attachments: attachmentMetas.map((a) => ({
      fileName: a.fileName,
      contentType: a.contentType,
      sizeBytes: a.sizeBytes,
    })),
    conversationHistory,
  };

  const userContent = `
Below is the context for a special request that the brand wants to discuss with the creator.

JSON input:
${JSON.stringify(payloadForLLM, null, 2)}

Please output ONLY the email body in ${outboundLanguageEn} (${outboundLanguage.language}), plain text, no JSON, no extra commentary.`;

  const raw = await callDeepSeekLLM(
    [{ role: "user", content: userContent }],
    systemPrompt
  );
  const bodyText = String(raw || "").trim();

  const subject = ctx.subjectForSend;

  const headers = {
    "X-Maxin-Influencer-Id": platformInfluencerId || "",
    "X-Maxin-Campaign-Id": campaignId || "",
    "X-Maxin-Source": "InfluencerAgent",
  };
  if (ctx.inReplyTo) {
    headers["In-Reply-To"] = ctx.inReplyTo;
  }
  if (ctx.references) {
    headers["References"] = ctx.references;
  }

  const traceId = buildTraceIdFromSourceKey(
    `special_request:${specialRequestId || eventRow.id}`
  );

  const delivery = await sendOrDraftAgentEmail({
    influencerId: platformInfluencerId,
    campaignId,
    fromAccount,
    toEmail,
    subject,
    bodyText,
    headers,
    sourceType: "ask_influencer_special_request",
    sourceEventId: eventRow.id,
    triggerType: "ask_influencer_special_request",
    traceId,
    emailPayload: { inReplyTo: payload.inReplyTo || null },
    payload: {
      specialRequest: {
        specialRequestId,
        specialRequestStatus,
      },
    },
    attachments: nodemailerAttachments,
    attachmentMetas,
  });
  if (delivery.drafted) return;
  const { result, sendErr, fromEmail } = delivery;

  // 发送成功后把附件落库（与人工发信一致），时间线即可预览/下载
  const dedupeKeys = [];
  if (nodemailerAttachments.length) {
    for (let idx = 0; idx < attachmentMetas.length; idx++) {
      const a = attachmentMetas[idx];
      // 入队时（Web 侧）已经把附件写进 outbound_attachments 了，这里直接复用，
      // 避免同一份文件存两遍；老事件没有这个键时再兜底插入。
      const reusedDedupeKey = a.outboundDedupeKey || null;
      const dedupeKey =
        reusedDedupeKey || `sr-att:${specialRequestId || eventRow.id}:${idx}`;
      let attachmentId = a.outboundAttachmentId || null;
      if (!reusedDedupeKey) {
        attachmentId = await insertOutboundAttachment({
          dedupeKey,
          filename: a.fileName,
          contentType: a.contentType,
          sizeBytes: a.sizeBytes,
          content: nodemailerAttachments[idx].content,
        });
      }
      dedupeKeys.push(dedupeKey);
      a.attachmentId = attachmentId || null;
    }
  }

  // 记录到对话记忆表
  try {
    await logConversationMessage({
      influencerId: platformInfluencerId,
      campaignId,
      direction: "bin",
      channel: "email",
      fromEmail,
      toEmail,
      subject,
      bodyText,
      messageId: result?.messageId || null,
      sourceType: "ask_influencer_special_request",
      sourceEventTable: "tiktok_influencer_agent_event",
      sourceEventId: eventRow.id,
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
          to: toEmail,
          subject,
          inReplyTo: payload.inReplyTo || null,
          messageId: result?.messageId || null,
        },
        specialRequest: {
          specialRequestId,
          specialRequestStatus,
        },
        ...(attachmentMetas.length
          ? {
              attachments: {
                source: "outbound_attachments",
                items: attachmentMetas,
              },
            }
          : {}),
        source: {
          eventTable: "tiktok_influencer_agent_event",
          eventId: eventRow.id,
        },
      },
    });
  } catch (err) {
    console.error(
      "[ProcessInfluencerAgentEvents] 写入特殊请求邮件到对话表失败:",
      err
    );
  }

  if (dedupeKeys.length && result?.messageId) {
    try {
      const rows = await queryTikTok(
        `
        SELECT id
        FROM tiktok_influencer_conversation_messages
        WHERE influencer_id = ? AND message_id = ?
        ORDER BY id DESC
        LIMIT 1
      `,
        [platformInfluencerId, result.messageId]
      );
      const conversationMessageId = rows?.[0]?.id || null;
      if (conversationMessageId) {
        await attachOutboundAttachmentsToConversationMessage({
          conversationMessageId,
          dedupeKeys,
        });
      }
    } catch (err) {
      console.error(
        "[ProcessInfluencerAgentEvents] 绑定特殊请求附件到对话消息失败:",
        err
      );
    }
  }

  if (sendErr) {
    throw sendErr;
  }
}

async function handleSendContractEmail(eventRow, payload) {
  const campaignId = payload.campaignId || eventRow.campaign_id || null;
  if (!campaignId) {
    throw new Error("send_contract_email 缺少 campaignId");
  }

  const handle = String(payload.tiktokUsername || payload.influencerId || "")
    .replace(/^@/, "")
    .trim();

  const platformInfluencerId = await resolvePlatformInfluencerIdForAgentEvent(
    campaignId,
    eventRow,
    payload
  );
  if (!platformInfluencerId) {
    throw new Error(
      "send_contract_email 无法解析平台 influencer_id（请回填 execution.influencer_id 或提供 payload.platformInfluencerId）"
    );
  }

  const influencer = await getInfluencerById(platformInfluencerId);
  if (!influencer) {
    throw new Error(
      `send_contract_email 主档不存在红人 influencer_id=${platformInfluencerId}`
    );
  }

  const toEmail =
    typeof influencer.influencerEmail === "string" &&
    influencer.influencerEmail.includes("@")
      ? influencer.influencerEmail.trim()
      : null;
  if (!toEmail) {
    throw new Error(
      `send_contract_email 红人 influencer_id=${platformInfluencerId} 缺少邮箱联系方式`
    );
  }

  // 合同 PDF：优先复用预生成（人工确认过）的文件，避免发送时重新生成导致文本漂移；
  // 未提供时现场生成（品牌点「确认同意」后的自动流程走这一支）。
  const preGenerated = payload.contract || null;
  const preAbsPath =
    preGenerated && (preGenerated.absPath || preGenerated.storageKey)
      ? preGenerated.absPath || resolveContractAbsPath(preGenerated.storageKey)
      : null;

  let contract = null;
  if (preAbsPath && fs.existsSync(preAbsPath)) {
    contract = {
      contractNo: preGenerated.contractNo,
      storageKey: preGenerated.storageKey || null,
      absPath: preAbsPath,
      clauses: preGenerated.clauses || null,
    };
  } else {
    const generated = await generateContractForExecution({
      campaignId,
      influencerHandle: handle,
      influencerId: platformInfluencerId,
    });
    contract = {
      contractNo: generated.contractNo,
      storageKey: generated.storageKey,
      absPath: generated.absPath,
      clauses: generated.clauses || null,
    };
  }

  // 冻结文件路径（人工补发复用已确认 PDF）没有 clauses，从执行表还原可变条款
  let clauses = contract.clauses;
  if (!clauses) {
    try {
      const execRow = await getExecutionRow(campaignId, handle || platformInfluencerId);
      const le = execRow?.lastEvent || {};
      clauses = buildContractClauses({
        deliverablesText: null,
        feeAmount: execRow?.flat_fee ?? null,
        commissionPercent:
          execRow?.commission_percent ?? execRow?.lastEvent?.approvedTerms?.commissionPercent ?? null,
        currency: execRow?.currency || "USD",
        sectionOverrides: le.contractSectionOverrides || null,
        additionalTerms: le.contractAdditionalTerms || null,
      });
    } catch {
      clauses = null;
    }
  }

  const pdfBuffer = fs.readFileSync(contract.absPath);
  const fileName = `${contract.contractNo}.pdf`;
  const revMatch = /-R(\d+)$/.exec(String(contract.contractNo || ""));
  const revision = revMatch ? Number(revMatch[1]) : 1;
  const previousContractNo =
    revision >= 2 ? String(contract.contractNo).replace(/-R\d+$/, "") : null;

  const campaignRow = await getCampaignById(campaignId).catch(() => null);
  const bodyText = await generateContractEmailBody({
    displayName: influencer.displayName,
    handle,
    contractNo: contract.contractNo,
    fileName,
    revision,
    previousContractNo,
    changeSummary: payload.contract?.changeSummary || null,
    brandName: campaignRow?.productInfo?.brandName || campaignRow?.productInfo?.productName || null,
    productName: campaignRow?.productInfo?.productName || campaignRow?.productInfo?.product || null,
    productLink: campaignRow?.productInfo?.productLink || null,
    campaignId,
    clauses,
  });

  const ctx = await resolveInfluencerThreadMailContext({
    influencerId: platformInfluencerId,
    influencer,
    campaignId,
  });
  const fromAccount = ctx.fromAccount;
  const subject = ctx.subjectForSend;

  const headers = {
    "X-Maxin-Influencer-Id": platformInfluencerId || "",
    "X-Maxin-Campaign-Id": campaignId || "",
    "X-Maxin-Source": "InfluencerAgent",
  };
  if (ctx.inReplyTo) headers["In-Reply-To"] = ctx.inReplyTo;
  if (ctx.references) headers["References"] = ctx.references;

  const traceId = buildTraceIdFromSourceKey(
    `contract:${contract.contractNo}:${eventRow.id}`
  );

  const attachmentMetas = [
    {
      fileName,
      storageKey: contract.storageKey,
      contentType: "application/pdf",
      sizeBytes: pdfBuffer.length,
    },
  ];

  const delivery = await sendOrDraftAgentEmail({
    influencerId: platformInfluencerId,
    campaignId,
    fromAccount,
    toEmail,
    subject,
    bodyText,
    headers,
    sourceType: "send_contract_email",
    sourceEventId: eventRow.id,
    triggerType: "send_contract_email",
    traceId,
    emailPayload: { inReplyTo: payload.inReplyTo || null },
    payload: {
      contract: { contractNo: contract.contractNo, storageKey: contract.storageKey },
    },
    attachments: [{ filename: fileName, contentType: "application/pdf", content: pdfBuffer }],
    attachmentMetas,
  });
  if (delivery.drafted) return;
  const { result, sendErr, fromEmail } = delivery;

  // 附件落库（与人工发信/特殊请求一致）
  const dedupeKeys = [];
  {
    const dedupeKey = `contract-att:${eventRow.id}`;
    const attachmentId = await insertOutboundAttachment({
      dedupeKey,
      filename: fileName,
      contentType: "application/pdf",
      sizeBytes: pdfBuffer.length,
      content: pdfBuffer,
    });
    dedupeKeys.push(dedupeKey);
    attachmentMetas[0].attachmentId = attachmentId || null;
  }

  try {
    await logConversationMessage({
      influencerId: platformInfluencerId,
      campaignId,
      direction: "bin",
      channel: "email",
      fromEmail,
      toEmail,
      subject,
      bodyText,
      messageId: result?.messageId || null,
      sourceType: "send_contract_email",
      sourceEventTable: "tiktok_influencer_agent_event",
      sourceEventId: eventRow.id,
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
          to: toEmail,
          subject,
          inReplyTo: payload.inReplyTo || null,
          messageId: result?.messageId || null,
        },
        contract: { contractNo: contract.contractNo, storageKey: contract.storageKey },
        attachments: { source: "outbound_attachments", items: attachmentMetas },
        source: {
          eventTable: "tiktok_influencer_agent_event",
          eventId: eventRow.id,
        },
      },
    });
  } catch (err) {
    console.error("[ProcessInfluencerAgentEvents] 写入合同邮件到对话表失败:", err);
  }

  if (dedupeKeys.length && result?.messageId) {
    try {
      const rows = await queryTikTok(
        `
        SELECT id
        FROM tiktok_influencer_conversation_messages
        WHERE influencer_id = ? AND message_id = ?
        ORDER BY id DESC
        LIMIT 1
      `,
        [platformInfluencerId, result.messageId]
      );
      const conversationMessageId = rows?.[0]?.id || null;
      if (conversationMessageId) {
        await attachOutboundAttachmentsToConversationMessage({
          conversationMessageId,
          dedupeKeys,
        });
      }
    } catch (err) {
      console.error("[ProcessInfluencerAgentEvents] 绑定合同附件到对话消息失败:", err);
    }
  }

  if (sendErr) {
    throw sendErr;
  }
}

async function handleAdvertiserExecutionFollowup(eventRow, payload) {
  const campaignId = payload.campaignId || eventRow.campaign_id || null;
  const action = payload.action || null;

  if (!action) {
    throw new Error("advertiser_execution_followup 缺少 action");
  }

  const platformInfluencerId = await resolvePlatformInfluencerIdForAgentEvent(
    campaignId,
    eventRow,
    payload
  );
  if (!platformInfluencerId) {
    throw new Error(
      "advertiser_execution_followup 无法解析平台 influencer_id（请回填 execution.influencer_id）"
    );
  }

  const influencer = await getInfluencerById(platformInfluencerId);
  if (!influencer) {
    throw new Error(
      `advertiser_execution_followup 主档不存在红人 influencer_id=${platformInfluencerId}`
    );
  }

  const toEmail =
    typeof influencer.influencerEmail === "string" &&
    influencer.influencerEmail.includes("@")
      ? influencer.influencerEmail.trim()
      : null;

  if (!toEmail) {
    throw new Error(
      `advertiser_execution_followup 红人 influencer_id=${platformInfluencerId} 缺少邮箱`
    );
  }

  const campaign = campaignId ? await getCampaignById(campaignId) : null;
  if (!campaign) {
    throw new Error(
      `advertiser_execution_followup campaign 不存在：${campaignId || "null"}`
    );
  }
  const productInfo = campaign.productInfo || {};
  const campaignInfo = campaign.campaignInfo || {};
  const campaignContext = {
    brandName: productInfo.brandName || null,
    productName: productInfo.productName || null,
    productLink: productInfo.productLink || null,
    platform: campaignInfo.platform || null,
    deliverables: campaignInfo.deliverables || null,
  };

  if (!campaignContext.brandName) {
    throw new Error(
      `advertiser_execution_followup campaign 缺少 brandName：${campaignId}`
    );
  }

  const conversationHistory = await loadConversationHistoryForInfluencer(
    platformInfluencerId,
    20
  );
  const askShippingConfirmation = payload.askShippingConfirmation === true;
  const sampleSentAt = payload.sampleSentAt || null;

  // 跟进邮件同样跟随红人沟通语言（回复语言 > bio 语言 > 英语）
  const followupLanguageRecord = await getInfluencerLanguage(
    platformInfluencerId
  ).catch(() => null);
  const followupLanguage = resolveCommunicationLanguage({
    replyLanguage: followupLanguageRecord?.communicationLanguage || null,
    bioLanguage: followupLanguageRecord?.bioLanguage || null,
    bioLanguageConfidence: followupLanguageRecord?.bioLanguageConfidence ?? null,
  });

  const bodyText = await generateAdvertiserFollowupBody({
    action,
    needSample: payload.needSample === true,
    hasShippingInfo: payload.hasShippingInfo === true,
    askShippingConfirmation,
    sampleSentAt,
    shippingConfirmedAt: payload.shippingConfirmedAt || null,
    campaignId,
    flatFee: payload.flatFee,
    currency: payload.currency || "USD",
    draftLink: payload.draftLink || null,
    draftFeedback: payload.draftFeedback || null,
    counterOffer: payload.counterOffer || null,
    counterReason: payload.counterReason || null,
    contentBrief: payload.contentBrief || null,
    campaignContext,
    shippingInfo: askShippingConfirmation ? payload.shippingInfo || null : null,
    conversationHistory,
    outboundLanguage: followupLanguage.language,
    outboundLanguageName: languageDisplayName(followupLanguage.language),
    influencer,
  });

  const ctx = await resolveInfluencerThreadMailContext({
    influencerId: platformInfluencerId,
    influencer,
    campaignId,
  });
  const fromAccount = ctx.fromAccount;
  const subject = ctx.subjectForSend;

  const headers = {
    "X-Maxin-Influencer-Id": platformInfluencerId || "",
    "X-Maxin-Campaign-Id": campaignId || "",
    "X-Maxin-Source": "InfluencerAgent",
  };
  if (ctx.inReplyTo) {
    headers["In-Reply-To"] = ctx.inReplyTo;
  }
  if (ctx.references) {
    headers["References"] = ctx.references;
  }

  const traceId = buildTraceIdFromSourceKey(
    `advertiser_followup:${action}:${eventRow.id}`
  );

  const delivery = await sendOrDraftAgentEmail({
    influencerId: platformInfluencerId,
    campaignId,
    fromAccount,
    toEmail,
    subject,
    bodyText,
    headers,
    sourceType: "advertiser_execution_followup",
    sourceEventId: eventRow.id,
    triggerType: `advertiser_execution_followup:${action}`,
    traceId,
    payload: {
      advertiserFollowup: {
        action,
        needSample: payload.needSample === true,
        hasShippingInfo: payload.hasShippingInfo === true,
        askShippingConfirmation,
        sampleSentAt,
        shippingInfo: payload.shippingInfo || null,
      },
    },
  });
  if (delivery.drafted) return;
  const { result, sendErr, fromEmail } = delivery;

  try {
    await logConversationMessage({
      influencerId: platformInfluencerId,
      campaignId,
      direction: "bin",
      channel: "email",
      fromEmail,
      toEmail,
      subject,
      bodyText,
      messageId: result?.messageId || null,
      sourceType: "advertiser_execution_followup",
      sourceEventTable: "tiktok_influencer_agent_event",
      sourceEventId: eventRow.id,
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
        advertiserFollowup: {
          action,
          needSample: payload.needSample === true,
          hasShippingInfo: payload.hasShippingInfo === true,
          askShippingConfirmation,
          sampleSentAt,
          shippingInfo: payload.shippingInfo || null,
        },
        email: {
          to: toEmail,
          subject,
          messageId: result?.messageId || null,
        },
        source: {
          eventTable: "tiktok_influencer_agent_event",
          eventId: eventRow.id,
        },
      },
    });
  } catch (err) {
    console.error(
      "[ProcessInfluencerAgentEvents] 写入广告主跟进邮件到对话表失败:",
      err
    );
  }

  if (sendErr) {
    throw sendErr;
  }
}

async function processInfluencerAgentEvent(eventRow) {
  await markInfluencerAgentEventStatus(eventRow.id, "processing", null);

  const payload = parseJsonOrObject(eventRow.payload) || {};
  const type = eventRow.event_type || payload.type || "generic";
  const campaignId = payload.campaignId || eventRow.campaign_id || null;
  const platformInfluencerId = await resolvePlatformInfluencerIdForAgentEvent(
    campaignId,
    eventRow,
    payload
  );
  if (platformInfluencerId) {
    const influencer = await getInfluencerById(platformInfluencerId).catch(() => null);
    if (influencer?.contactStatus === "do_not_contact") {
      await markInfluencerAgentEventStatus(
        eventRow.id,
        "skipped",
        "influencer_do_not_contact"
      );
      return;
    }
  }

  if (type === "first_outreach") {
    await handleFirstOutreach(eventRow, payload);
    await markInfluencerAgentEventStatus(eventRow.id, "succeeded", null);
    return;
  }

  if (type === "outbound_email") {
    await handleOutboundEmail(eventRow, payload);
    await markInfluencerAgentEventStatus(eventRow.id, "succeeded", null);
    return;
  }

  if (type === "ask_influencer_special_request") {
    await handleAskInfluencerSpecialRequest(eventRow, payload);
    await markInfluencerAgentEventStatus(eventRow.id, "succeeded", null);
    return;
  }

  if (type === "send_contract_email") {
    await handleSendContractEmail(eventRow, payload);
    await markInfluencerAgentEventStatus(eventRow.id, "succeeded", null);
    return;
  }

  if (type === "advertiser_execution_followup") {
    await handleAdvertiserExecutionFollowup(eventRow, payload);
    await markInfluencerAgentEventStatus(eventRow.id, "succeeded", null);
    return;
  }

  await markInfluencerAgentEventStatus(
    eventRow.id,
    "skipped",
    `未识别的 event_type：${type}`
  );
}

async function main() {
  const mode = resolveAgentEventMode();
  const onlyEventId = resolveOnlyEventId();
  const events = onlyEventId
    ? [await claimInfluencerAgentEventById(onlyEventId)].filter(Boolean)
    : await fetchPendingInfluencerAgentEvents(20, mode);
  if (!events.length) {
    console.log(
      onlyEventId
        ? `[ProcessInfluencerAgentEvents] 事件 ${onlyEventId} 不存在或不是 pending，跳过。`
        : `[ProcessInfluencerAgentEvents] mode=${mode} 当前没有 pending 事件。`
    );
    return;
  }

  console.log(
    `[ProcessInfluencerAgentEvents] mode=${mode}${onlyEventId ? ` (only event ${onlyEventId})` : ""} 准备处理 ${events.length} 条事件。`
  );

  for (const ev of events) {
    try {
      await processInfluencerAgentEvent(ev);
    } catch (err) {
      console.error(
        "[ProcessInfluencerAgentEvents] 处理事件时出现未捕获错误:",
        err
      );
      if (err instanceof OutboundCooldownError) {
        await markInfluencerAgentEventStatus(
          ev.id,
          "pending",
          err?.message || String(err)
        );
        continue;
      }
      await markInfluencerAgentEventStatus(
        ev.id,
        "failed",
        `未捕获错误: ${err?.message || String(err)}`,
        err?.senderEmail || null
      );
    }
  }
}

// 仅直接运行时消费队列；被测试 import 时不触发 main()
const invokedAsMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedAsMain) {
  main()
    .then(() => {
      console.log("[ProcessInfluencerAgentEvents] 本次处理完成。");
      process.exit(0);
    })
    .catch((err) => {
      console.error("[ProcessInfluencerAgentEvents] 运行出错:", err);
      process.exit(1);
    });
}
