import { NextResponse } from "next/server";
import { getInfluencerById } from "../../../../../../lib/db/influencer-dao.js";
import { getLatestInboundMessageId } from "../../../../../../lib/db/influencer-conversations-dao.js";
import { queryTikTok } from "../../../../../../lib/db/mysql-tiktok.js";
import { resolveInfluencerThreadMailContext } from "../../../../../../lib/email/influencer-thread-mail.js";
import { sendMail } from "../../../../../../lib/email/enterprise-mail-client.js";
import { logConversationMessage } from "../../../../../../lib/db/influencer-conversation-dao.js";
import {
  attachOutboundAttachmentsToConversationMessage,
  insertOutboundAttachment,
} from "../../../../../../lib/db/influencer-outbound-attachments-dao.js";
import {
  buildTraceIdFromInboundMessageId,
  buildTraceIdFromSourceKey,
} from "../../../../../../lib/utils/timeline-ids.js";

function nonEmpty(v) {
  const s = v == null ? "" : String(v).trim();
  return s ? s : null;
}

export async function POST(req, { params }) {
  try {
    const influencerId = params?.influencerId;
    if (!influencerId) {
      return NextResponse.json(
        { success: false, error: "缺少 influencerId" },
        { status: 400 }
      );
    }

    const influencer = await getInfluencerById(influencerId);
    if (!influencer) {
      return NextResponse.json(
        { success: false, error: "找不到 influencer" },
        { status: 404 }
      );
    }

    const form = await req.formData();
    const text = nonEmpty(form.get("text"));
    const campaignId = nonEmpty(form.get("campaignId"));
    const draftEventId = nonEmpty(form.get("draftEventId"));
    const contentOrigin = nonEmpty(form.get("contentOrigin")) || null; // human_written / human_edited_agent
    const sendMode = nonEmpty(form.get("sendMode")) || null; // human_manual_send / human_approved

    if (!text) {
      return NextResponse.json(
        { success: false, error: "缺少 text" },
        { status: 400 }
      );
    }

    const toEmail = influencer.influencerEmail;
    if (!toEmail) {
      return NextResponse.json(
        { success: false, error: "红人缺少 influencer_email" },
        { status: 400 }
      );
    }

    const latestInboundMid = await getLatestInboundMessageId(influencerId);
    const ctx = await resolveInfluencerThreadMailContext({
      influencerId,
      influencer,
      preferredInReplyToMessageId: latestInboundMid,
      campaignId,
    });

    const subject = ctx.subjectForSend;

    const headers = {
      "X-Maxin-Influencer-Id": influencerId || "",
      "X-Maxin-Campaign-Id": campaignId || "",
      "X-Maxin-Source": "HumanOperator",
    };
    if (ctx.inReplyTo) headers["In-Reply-To"] = ctx.inReplyTo;
    if (ctx.references) headers["References"] = ctx.references;

    const files = form.getAll("attachments") || [];
    const clientMessageId = `human-${Date.now()}-${Math.random()
      .toString(16)
      .slice(2)}`;

    const dedupeKeys = [];
    const attachmentMetas = [];
    const nodemailerAttachments = [];

    for (let idx = 0; idx < files.length; idx++) {
      const f = files[idx];
      if (!f || typeof f.arrayBuffer !== "function") continue;
      const buf = Buffer.from(await f.arrayBuffer());
      const filename = nonEmpty(f.name) || `attachment-${idx + 1}`;
      const contentType = nonEmpty(f.type) || null;
      const sizeBytes = typeof f.size === "number" ? f.size : buf.length;
      const dedupeKey = `outatt:${clientMessageId}:${idx}`;

      const attachmentId = await insertOutboundAttachment({
        dedupeKey,
        filename,
        contentType,
        sizeBytes,
        content: buf,
      });

      dedupeKeys.push(dedupeKey);
      attachmentMetas.push({
        attachmentId: attachmentId || null,
        dedupeKey,
        filename,
        contentType,
        sizeBytes,
      });
      nodemailerAttachments.push({
        filename,
        contentType,
        content: buf,
      });
    }

    const traceId = latestInboundMid
      ? buildTraceIdFromInboundMessageId(latestInboundMid)
      : ctx.parentMessageId
        ? buildTraceIdFromInboundMessageId(ctx.parentMessageId)
        : buildTraceIdFromSourceKey(`human_send:${clientMessageId}`);

    let result = null;
    let sendErr = null;
    try {
      result = await sendMail({
        fromAccount: ctx.fromAccount,
        to: toEmail,
        subject,
        text,
        headers,
        attachments: nodemailerAttachments,
      });
    } catch (err) {
      sendErr = err;
    }

    // 写入时间线（失败也写）
    await logConversationMessage({
      influencerId,
      campaignId,
      direction: "bin",
      channel: "email",
      fromEmail:
        ctx.fromAccount.email ||
        ctx.fromAccount.email_address ||
        ctx.fromAccount.username ||
        ctx.fromAccount.account ||
        null,
      toEmail: toEmail,
      subject,
      bodyText: text,
      messageId: result?.messageId || `client:${clientMessageId}`,
      sourceType: "human_outbound_email",
      sourceEventTable: null,
      sourceEventId: null,
      sentAt: new Date(),
      eventType: "email_outbound",
      eventTime: new Date(),
      actorType: "human",
      sendMode: sendMode || (draftEventId ? "human_approved" : "human_manual_send"),
      contentOrigin:
        contentOrigin || (draftEventId ? "human_edited_agent" : "human_written"),
      traceId,
      payload: {
        kind: "email_outbound",
        status: sendErr ? "failed" : "succeeded",
        error: sendErr ? { message: sendErr?.message || String(sendErr) } : null,
        email: {
          to: toEmail,
          subject,
          inReplyTo: latestInboundMid || ctx.parentMessageId || null,
          messageId: result?.messageId || null,
          clientMessageId,
        },
        attachments: {
          source: "outbound_attachments",
          items: attachmentMetas.map((a) => ({
            attachmentId: a.attachmentId,
            dedupeKey: a.dedupeKey,
            filename: a.filename,
            contentType: a.contentType,
            sizeBytes: a.sizeBytes,
          })),
        },
      },
    });

    // 绑定附件到 conversation_message_id（通过 message_id 回查最新插入行）
    if (dedupeKeys.length) {
      const lookupMid = result?.messageId || `client:${clientMessageId}`;
      const rows = await queryTikTok(
        `
        SELECT id
        FROM tiktok_influencer_conversation_messages
        WHERE influencer_id = ? AND message_id = ?
        ORDER BY id DESC
        LIMIT 1
      `,
        [influencerId, lookupMid]
      );
      const conversationMessageId = rows?.[0]?.id || null;
      if (conversationMessageId) {
        await attachOutboundAttachmentsToConversationMessage({
          conversationMessageId,
          dedupeKeys,
        });
      }
    }

    return NextResponse.json({
      success: !sendErr,
      messageId: result?.messageId || null,
      clientMessageId,
      error: sendErr ? sendErr?.message || String(sendErr) : null,
    });
  } catch (error) {
    console.error("[Influencer Send API] 失败:", error);
    return NextResponse.json(
      { success: false, error: error?.message || "发送失败" },
      { status: 500 }
    );
  }
}

