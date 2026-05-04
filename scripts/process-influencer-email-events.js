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
import { callDeepSeekLLM } from "../lib/utils/llm-client.js";
import { sendMail } from "../lib/email/enterprise-mail-client.js";
import { logConversationMessage } from "../lib/db/influencer-conversation-dao.js";
import { influencerAgentBasePrompt } from "../lib/agents/influencer-agent-prompt.js";
import { loadConversationHistoryForInfluencer } from "../lib/agents/influencer-agent.js";
import { getInfluencerById } from "../lib/db/influencer-dao.js";
import { resolveInfluencerThreadMailContext } from "../lib/email/influencer-thread-mail.js";
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
           e.influencer_id,
           e.stage,
           e.influencer_snapshot,
           e.last_event,
           c.product_info,
           c.campaign_info
    FROM tiktok_campaign_execution e
    JOIN tiktok_campaign c ON e.campaign_id = c.id
    WHERE e.influencer_id = ?
  `,
    [influencerId]
  );

  return rows.map((r) => ({
    campaignId: r.campaign_id,
    influencerId: r.influencer_id,
    stage: r.stage,
    influencerSnapshot: parseJsonOrObject(r.influencer_snapshot),
    lastEvent: parseJsonOrObject(r.last_event),
    productInfo: parseJsonOrObject(r.product_info),
    campaignInfo: parseJsonOrObject(r.campaign_info),
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

    const influencerId =
      email.influencerId || event.influencer_id || exec?.influencerId || null;
    const campaignId = email.campaignId || exec?.campaignId || null;

    const to = email.to || event.from_email;

    const influencerRow =
      influencerId && (await getInfluencerById(influencerId).catch(() => null));

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

    // 直接发信（失败也要落时间线事件，方便排查）
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

    // 写入对话记忆表
    try {
      await logConversationMessage({
        influencerId,
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
    const influencerId =
      ae.influencerId || event.influencer_id || exec?.influencerId || null;
    const eventType = ae.type || ae.eventType || "generic";

    const payload = {
      ...ae,
      campaignId,
      influencerId,
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

    let shippingInfo =
      upd.shippingInfo && typeof upd.shippingInfo === "object"
        ? upd.shippingInfo
        : null;

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

    if (!videoLink && event.body_text) {
      const m = event.body_text.match(
        /(https?:\/\/www\.tiktok\.com\/@[^\s/]+\/video\/\d+)/
      );
      if (m) {
        videoLink = m[1];
      }
    }

    const payload = {
      type: upd.type || "execution_update_suggested",
      campaignId,
      influencerId: exec.influencerId,
      newStage,
      note: note || "",
      flatFeeUSD: flatFee,
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

  const conversationHistory = await loadConversationHistoryForInfluencer(
    event.influencer_id,
    20
  );

  const influencerRow =
    event.influencer_id &&
    (await getInfluencerById(event.influencer_id).catch(() => null));
  const threadMailCtx = await resolveInfluencerThreadMailContext({
    influencerId: event.influencer_id,
    influencer: influencerRow,
    preferredInReplyToMessageId: event.message_id || null,
  });

  const payload = {
    influencerId: event.influencer_id || null,
    email: {
      from: event.from_email,
      to: event.to_email,
      subject: event.subject,
      bodyText: event.body_text,
      messageId: event.message_id,
      inReplyTo: event.in_reply_to,
      createdAt: event.created_at,
      attachments: [],
    },
    activeExecutions: executions,
    conversationHistory,
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

【当前任务：处理红人邮件事件并给出业务决策】
- 你正收到一封红人发来的最新邮件（email），你还可以看到：
  - conversationHistory：你与该红人的历史对话记录；
  - activeExecutions：该红人在各个 campaign 下当前的执行状态；
  - threadInfo：规范化线程标题（canonicalThreadSubject）、根/父 Message-ID、以及建议的续信标题（suggestedSubjectForReply，通常为 Re: + 规范化标题）。
- 你的目标是：在尊重红人体验的前提下，做出合理的业务决策，并通过结构化 JSON 告诉系统要做什么。

输入 JSON 中包含：
- email：当前这封邮件的关键信息；
- activeExecutions：该红人当前所有相关执行记录；
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
        "videoLink": "https://www.tiktok.com/@xxx/video/123",
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
    ]
  }

- updates 只是「建议」，会被写入 tiktok_advertiser_agent_event，由 CampaignExecutionAgent 决定是否真正更新数据库。
- newStage 必须是下列之一：
  - "pending_quote"
  - "quote_submitted"
  - "pending_sample"
  - "sample_sent"
  - "pending_draft"
  - "draft_submitted"
  - "published"
  - "failed"
- 如果你认为当前邮件不需要修改任何 Campaign 的 stage，请返回：{"updates": []}，但你仍然可以返回 outboundEmails 或 agentEvents。
- 对于 creator_replied_special_request：当红人明确同意/接受品牌方的特殊请求（如改价、改时间、加条数等）时，specialRequestStatus 必须为 "resolved"；仅当红人拒绝或提出新条件需品牌再决定时，才用 "pending_brand"。
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

