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
import {
  getOutboundAccountForInfluencer,
  sendMail,
} from "../lib/email/enterprise-mail-client.js";
import { logConversationMessage } from "../lib/db/influencer-conversation-dao.js";
import { influencerAgentBasePrompt } from "../lib/agents/influencer-agent-prompt.js";

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

async function loadConversationHistoryForEvent(event, executions, limit = 20) {
  const influencerId = event.influencer_id;
  if (!influencerId) return [];

  const campaignIds = Array.from(
    new Set(
      (executions || [])
        .map((e) => e.campaignId)
        .filter((id) => typeof id === "string" && id)
    )
  );

  const n = Math.min(50, Math.max(1, Number(limit) || 20));
  const params = [influencerId];
  let campaignFilter = "";
  if (campaignIds.length) {
    const placeholders = campaignIds.map(() => "?").join(",");
    campaignFilter = `AND (campaign_id IS NULL OR campaign_id IN (${placeholders}))`;
    params.push(...campaignIds);
  }
  // LIMIT 使用内联数字，避免部分驱动对 LIMIT ? 的参数校验问题

  const rows = await queryTikTok(
    `
    SELECT
      influencer_id,
      campaign_id,
      direction,
      channel,
      from_email,
      to_email,
      subject,
      body_text,
      message_id,
      source_type,
      source_event_table,
      source_event_id,
      sent_at,
      created_at
    FROM tiktok_influencer_conversation_messages
    WHERE influencer_id = ?
      ${campaignFilter}
    ORDER BY COALESCE(sent_at, created_at) DESC
    LIMIT ${n}
  `,
    params
  );

  return (rows || []).map((r) => ({
    influencerId: r.influencer_id,
    campaignId: r.campaign_id,
    direction: r.direction,
    channel: r.channel,
    fromEmail: r.from_email,
    toEmail: r.to_email,
    subject: r.subject,
    bodyText: r.body_text,
    messageId: r.message_id,
    sourceType: r.source_type,
    sourceEventTable: r.source_event_table,
    sourceEventId: r.source_event_id,
    sentAt: r.sent_at,
    createdAt: r.created_at,
  }));
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
  await queryTikTok(
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
}

async function handleOutboundEmails(decision, event, executions, threadInfo) {
  if (!decision || !Array.isArray(decision.outboundEmails)) return;

  // 当前版本：收到红人回邮后，直接在本 Worker 里发邮件给红人，
  // 不再为 outboundEmails 写入 tiktok_influencer_agent_event。
  const fromAccount = await getOutboundAccountForInfluencer(null);

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

    const threadSubject =
      email.threadSubject ||
      threadInfo?.threadSubject ||
      event.subject ||
      "Binfluencer Collaboration";

    // 标题策略：统一使用 Re: <baseSubject>（如果 baseSubject 已经以 "Re:" 开头就直接用）
    const baseSubject = threadSubject;
    const subject =
      email.subject ||
      (baseSubject.startsWith("Re:") ? baseSubject : `Re: ${baseSubject}`);
    const body = email.body || email.bodyText || "";

    const headers = {
      "X-Maxin-Influencer-Id": influencerId || "",
      "X-Maxin-Campaign-Id": campaignId || "",
      "X-Maxin-Source": "InfluencerAgent",
    };
    const rootMessageId = threadInfo?.rootMessageId || null;
    const inReplyTo = email.inReplyTo || event.message_id || rootMessageId;
    if (inReplyTo) {
      headers["In-Reply-To"] = inReplyTo;
    }
    // References：保留首封 + 当前要回复的 messageId
    const refs = [];
    if (rootMessageId) refs.push(`<${rootMessageId}>`);
    if (event.message_id && event.message_id !== rootMessageId) {
      refs.push(`<${event.message_id}>`);
    }
    if (refs.length) {
      headers["References"] = refs.join(" ");
    }

    // 直接发信
    const result = await sendMail({
      fromAccount,
      to,
      subject,
      text: body,
      headers,
    });

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
      });
    } catch (err) {
      console.error(
        "[ProcessInfluencerEmailEvents] 写入 tiktok_influencer_conversation_messages 失败:",
        err
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

    await createCampaignAgentEvent({
      campaignId,
      influencerId,
      eventType,
      payload,
    });
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

    await createCampaignAgentEvent({
      campaignId,
      influencerId: exec.influencerId,
      eventType: payload.type,
      payload,
    });
  }
}

async function processEvent(event) {
  await markEventStatus(event.id, "processing", null);

  const executions = await fetchActiveExecutionsForInfluencer(
    event.influencer_id
  );

  const conversationHistory = await loadConversationHistoryForEvent(
    event,
    executions,
    20
  );

  // 计算线程首封 subject 和根 messageId（按时间正序）
  let threadSubject = null;
  let rootMessageId = null;
  if (conversationHistory && conversationHistory.length) {
    const asc = [...conversationHistory].sort((a, b) => {
      const ta = new Date(a.sentAt || a.createdAt || 0).getTime();
      const tb = new Date(b.sentAt || b.createdAt || 0).getTime();
      return ta - tb;
    });
    const firstWithId = asc.find((m) => m.messageId);
    rootMessageId = firstWithId?.messageId || null;
    // 优先选择以 "Binfluencer x" 开头的线程标题，其次任意一封 Bin 发出的邮件标题
    const preferredBin = asc.find(
      (m) =>
        m.direction === "bin" &&
        m.subject &&
        /^Binfluencer x /i.test(m.subject.trim())
    );
    const firstBin = preferredBin
      ? preferredBin
      : asc.find(
      (m) => m.direction === "bin" && m.subject && m.subject.trim()
      );
    threadSubject = firstBin?.subject || null;
  }

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
      threadSubject,
      rootMessageId,
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
  - threadInfo：当前线程的基础标题（threadSubject）和根 Message-ID（rootMessageId）。
- 你的目标是：在尊重红人体验的前提下，做出合理的业务决策，并通过结构化 JSON 告诉系统要做什么。

输入 JSON 中包含：
- email：当前这封邮件的关键信息；
- activeExecutions：该红人当前所有相关执行记录；
- conversationHistory：按时间倒序的最近若干条对话消息（Bin 与红人的往来，direction=bin/ influencer）。
  - 你需要基于 conversationHistory「续写对话」，而不是重新自我介绍或重复问过的问题。
  - payload.threadInfo 中可能包含线程的基础标题（threadSubject），如果你不填 subject，我们会自动使用统一标题并加上 "Re:"。

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
    await handleOutboundEmails(decision, event, executions, {
      threadSubject,
      rootMessageId,
    });
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

