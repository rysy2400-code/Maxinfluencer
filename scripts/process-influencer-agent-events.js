/**
 * Worker：消费 tiktok_influencer_agent_event，作为 InfluencerAgent 统一负责对红人的所有发信动作。
 *
 * 职责（MVP）：
 * - 处理 first_outreach 事件：调用 sendOutreach 发首封邀约邮件；
 * - 处理 outbound_email 事件：根据 payload 中的信息直接发邮件给红人，并写入对话记忆表。
 *
 * 使用方式（示例）：
 *   node scripts/process-influencer-agent-events.js
 */

import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import { queryTikTok } from "../lib/db/mysql-tiktok.js";
import { getInfluencerById } from "../lib/db/influencer-dao.js";
import {
  sendOutreach,
  loadConversationHistoryForInfluencer,
} from "../lib/agents/influencer-agent.js";
import { sendMail } from "../lib/email/enterprise-mail-client.js";
import { resolveInfluencerThreadMailContext } from "../lib/email/influencer-thread-mail.js";
import { logConversationMessage } from "../lib/db/influencer-conversation-dao.js";
import { callDeepSeekLLM } from "../lib/utils/llm-client.js";
import { influencerAgentBasePrompt } from "../lib/agents/influencer-agent-prompt.js";
import {
  buildTraceIdFromInboundMessageId,
  buildTraceIdFromSourceKey,
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

async function fetchPendingInfluencerAgentEvents(limit = 20) {
  const n = Math.min(50, Math.max(1, Number(limit) || 20));
  const rows = await queryTikTok(
    `
    SELECT *
    FROM tiktok_influencer_agent_event
    WHERE status = 'pending'
    ORDER BY created_at ASC
    LIMIT ${n}
  `,
    []
  );
  return rows || [];
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

async function markInfluencerAgentEventStatus(id, status, errorMessage = null) {
  await queryTikTok(
    `
    UPDATE tiktok_influencer_agent_event
    SET status = ?, error_message = ?, updated_at = NOW()
    WHERE id = ?
  `,
    [status, errorMessage, id]
  );
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
    snapshot,
  });
}

async function handleOutboundEmail(eventRow, payload) {
  const campaignId = payload.campaignId || eventRow.campaign_id || null;
  const platformInfluencerId = await resolvePlatformInfluencerIdForAgentEvent(
    campaignId,
    eventRow,
    payload
  );
  const influencerId = platformInfluencerId || payload.influencerId || eventRow.influencer_id || null;

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

  let result = null;
  let sendErr = null;
  try {
    result = await sendMail({
      fromAccount,
      to,
      subject,
      text: body,
      headers,
    });
  } catch (err) {
    sendErr = err;
  }

  // 记录到对话记忆表
  try {
    await logConversationMessage({
      influencerId: platformInfluencerId || influencerId,
      campaignId,
      direction: "bin",
      channel: "email",
      fromEmail:
        fromAccount.email ||
        fromAccount.email_address ||
        fromAccount.username ||
        fromAccount.account ||
        null,
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

  const systemPrompt = `
${influencerAgentBasePrompt}

【当前任务：向红人转达品牌的「特殊请求」，并询问红人是否接受】
- 你现在要给指定红人写一封英文邮件，内容是转达品牌方/执行侧的一个「特殊请求」。
- specialRequestId 表示这一轮特殊请求会话的唯一 ID，你可以在心里当作标签，用于保持这轮沟通的一致性，但不需要在邮件里直接写出 ID。
- 本轮对应的 campaignId 为 ${campaignId || "null"}；若 conversationHistory 涉及多个 campaign，你必须在正文中自然区分，避免混淆。
- brandMessage 是品牌/执行侧给你的自然语言说明，你需要用自己的话把它转述给红人。
- 语气：专业、友好、简洁，像一对一沟通，而不是群发模板。
- 要清楚地告诉红人：品牌方希望他/她确认是否愿意按这个请求执行（例如改时间、改脚本、多加一条内容并增加预算等），并邀请红人表达自己的想法或修改意见。
- 可以根据 conversationHistory 判断目前合作进展，适当提及之前的沟通，但不要重复上一封几乎一模一样的句子。
- 只输出英文邮件正文（纯文本，不要 markdown，不要 JSON，不要额外解释）。`;

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
    conversationHistory,
  };

  const userContent = `
Below is the context for a special request that the brand wants to discuss with the creator.

JSON input:
${JSON.stringify(payloadForLLM, null, 2)}

Please output ONLY the email body in English (plain text), no JSON, no extra commentary.`;

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

  // 记录到对话记忆表
  try {
    await logConversationMessage({
      influencerId: platformInfluencerId,
      campaignId,
      direction: "bin",
      channel: "email",
      fromEmail:
        fromAccount.email ||
        fromAccount.email_address ||
        fromAccount.username ||
        fromAccount.account ||
        null,
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

  if (sendErr) {
    throw sendErr;
  }
}

async function processInfluencerAgentEvent(eventRow) {
  await markInfluencerAgentEventStatus(eventRow.id, "processing", null);

  const payload = parseJsonOrObject(eventRow.payload) || {};
  const type = eventRow.event_type || payload.type || "generic";

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

  await markInfluencerAgentEventStatus(
    eventRow.id,
    "skipped",
    `未识别的 event_type：${type}`
  );
}

async function main() {
  const events = await fetchPendingInfluencerAgentEvents(20);
  if (!events.length) {
    console.log("[ProcessInfluencerAgentEvents] 当前没有 pending 事件。");
    return;
  }

  console.log(
    `[ProcessInfluencerAgentEvents] 准备处理 ${events.length} 条 pending 事件。`
  );

  for (const ev of events) {
    try {
      await processInfluencerAgentEvent(ev);
    } catch (err) {
      console.error(
        "[ProcessInfluencerAgentEvents] 处理事件时出现未捕获错误:",
        err
      );
      await markInfluencerAgentEventStatus(
        ev.id,
        "failed",
        `未捕获错误: ${err?.message || String(err)}`
      );
    }
  }
}

main()
  .then(() => {
    console.log("[ProcessInfluencerAgentEvents] 本次处理完成。");
    process.exit(0);
  })
  .catch((err) => {
    console.error("[ProcessInfluencerAgentEvents] 运行出错:", err);
    process.exit(1);
  });

