/**
 * 轮询企业邮箱收件箱的脚本
 *
 * 职责：
 * - 从 op_contacts 中读取对外邮箱账号
 * - 调用 enterprise-mail-client.listRecentMessages 拉取近一段时间的新邮件
 * - 将每封邮件写入 tiktok_influencer_email_events 事件表（status=pending）
 *   不直接更新业务表，由后续 Worker / Agent 消费事件表进行决策
 *
 * 使用方式（示例）：
 *   node scripts/poll-influencer-replies.js
 */

import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import { queryTikTok } from "../lib/db/mysql-tiktok.js";
import { listRecentMessages } from "../lib/email/enterprise-mail-client.js";
import { logConversationMessage } from "../lib/db/influencer-conversation-dao.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
dotenv.config({ path: path.join(projectRoot, ".env") });
dotenv.config({ path: path.join(projectRoot, ".env.local") });

function extractLatestReply(bodyText) {
  if (!bodyText) return "";
  const s = String(bodyText);

  // 常见引用开头模式（英文 / 中文）
  const patterns = [
    /\nOn .+wrote:/i,
    /\n于.+写道：/,
    /\n在.+写道：/,
    /\n-{2,}\s*Original Message\s*-{2,}/i,
    /\n_{2,}\s*Forwarded message\s*_{2,}/i,
    /\nFrom:\s.+\r?\n/i,
    /\n<[^>]+>\s.+写道：/, // Gmail 中文格式: <annie@...> 于xxx写道：
  ];

  let cutIndex = s.length;
  for (const re of patterns) {
    const idx = s.search(re);
    if (idx >= 0 && idx < cutIndex) {
      cutIndex = idx;
    }
  }

  // 兜底：遇到第一行以 ">" 开头的 block 时截断
  const quoteIdx = s.search(/\n>/);
  if (quoteIdx >= 0 && quoteIdx < cutIndex) {
    cutIndex = quoteIdx;
  }

  const main = s.slice(0, cutIndex).trim();
  return main || s.trim();
}

async function getAllOpContacts() {
  try {
    const rows = await queryTikTok("SELECT * FROM op_contacts");
    return rows || [];
  } catch (err) {
    console.error("[PollInfluencerReplies] 查询 op_contacts 失败:", err);
    return [];
  }
}

async function resolveInfluencerIdByEmail(email) {
  const e = (email || "").trim().toLowerCase();
  if (!e || !e.includes("@")) return null;
  try {
    const rows = await queryTikTok(
      `
      SELECT influencer_id
      FROM tiktok_influencer
      WHERE LOWER(TRIM(influencer_email)) = ?
      LIMIT 1
    `,
      [e]
    );
    return rows && rows[0] ? rows[0].influencer_id : null;
  } catch (err) {
    console.error("[PollInfluencerReplies] 反查 influencer_id 失败:", err);
    return null;
  }
}

async function pollOnce() {
  const allAccounts = await getAllOpContacts();
  // 当前仅轮询指定测试账号，便于验证链路；后续可移除该过滤恢复多账号支持
  const accounts = allAccounts.filter(
    (a) =>
      a.email === "annie@binfluencer.online" ||
      a.email_address === "annie@binfluencer.online" ||
      a.username === "annie@binfluencer.online"
  );
  if (!accounts.length) {
    console.warn("[PollInfluencerReplies] 没有可用企业邮箱账号，退出。");
    return;
  }

  // 拉取最近 24 小时内的邮件；写入 event 时依赖 message_id 唯一键去重，只写入未处理过的新邮件
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);

  for (const account of accounts) {
    console.log(
      "[PollInfluencerReplies] 开始轮询账号：",
      account.email || account.email_address || account.username || account.account
    );

    const messages = await listRecentMessages({ account, since });
    if (!messages || messages.length === 0) {
      console.log(
        "[PollInfluencerReplies] 本次轮询未发现新邮件（或均被过滤），账号：",
        account.email || account.email_address || account.username || account.account
      );
      continue;
    }

    console.log(
      "[PollInfluencerReplies] 本次轮询拉取到邮件数量：",
      messages.length,
      "（写入 event 时按 message_id 去重，仅新邮件会插入）示例：",
      messages.slice(0, 3).map((m) => ({
        uid: m.uid,
        messageId: m.messageId,
        from: m.from,
        to: m.to,
        subject: m.subject,
        date: m.date,
      }))
    );

    for (const msg of messages) {
      if (!msg.messageId) {
        continue;
      }

      const influencerId = await resolveInfluencerIdByEmail(msg.from);
      const cleanedBody = extractLatestReply(msg.bodyText || "");

      // 事件表使用 message_id 做唯一键，避免重复插入
      try {
        await queryTikTok(
          `
          INSERT IGNORE INTO tiktok_influencer_email_events (
            influencer_id,
            message_id,
            conversation_id,
            from_email,
            to_email,
            subject,
            body_text,
            raw_headers,
            in_reply_to,
            received_at,
            candidate_campaign_ids,
            status
          ) VALUES (
            ?,
            ?,
            NULL,
            ?,
            ?,
            ?,
            ?,
            ?,
            ?,
            ?,
            NULL,
            'pending'
          )
        `,
          [
            influencerId,
            msg.messageId,
            msg.from || "",
            msg.to || "",
            msg.subject || "",
            cleanedBody,
            msg.rawHeaders || null,
            msg.inReplyTo || null,
            msg.date || null,
          ]
        );

        const idRows = await queryTikTok(
          "SELECT id FROM tiktok_influencer_email_events WHERE message_id = ? LIMIT 1",
          [msg.messageId]
        );
        const eventId = idRows && idRows[0] ? idRows[0].id : null;

        if (eventId && Array.isArray(msg.attachments) && msg.attachments.length) {
          for (const a of msg.attachments) {
            try {
              await queryTikTok(
                `
                INSERT IGNORE INTO tiktok_influencer_email_event_attachments (
                  event_id, message_id, part, content_id,
                  filename, content_type, size_bytes, content
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
              `,
                [
                  eventId,
                  msg.messageId,
                  a.part || null,
                  a.contentId || null,
                  a.filename || null,
                  a.contentType || null,
                  typeof a.sizeBytes === "number" ? a.sizeBytes : null,
                  a.content,
                ]
              );
            } catch (err) {
              console.error(
                "[PollInfluencerReplies] 写入附件 tiktok_influencer_email_event_attachments 失败：",
                err
              );
            }
          }
        }

        // 记录红人来信到对话记忆表（仅保存清洗后的最新回复内容）
        try {
          await logConversationMessage({
            influencerId,
            campaignId: null,
            direction: "influencer",
            channel: "email",
            fromEmail: msg.from || null,
            toEmail: msg.to || null,
            subject: msg.subject || null,
            bodyText: cleanedBody,
            messageId: msg.messageId || null,
            sourceType: "influencer_email_event",
            sourceEventTable: "tiktok_influencer_email_events",
            sourceEventId: eventId,
            sentAt: msg.date || null,
          });
        } catch (err) {
          console.error(
            "[PollInfluencerReplies] 写入 tiktok_influencer_conversation_messages 失败：",
            err
          );
        }

        console.log("[PollInfluencerReplies] 已写入事件 tiktok_influencer_email_events：", {
          messageId: msg.messageId,
          from: msg.from,
          to: msg.to,
          subject: msg.subject,
          attachments: Array.isArray(msg.attachments) ? msg.attachments.length : 0,
        });
      } catch (err) {
        console.error(
          "[PollInfluencerReplies] 写入 tiktok_influencer_email_events 失败：",
          err
        );
      }
    }
  }
}

pollOnce()
  .then(() => {
    console.log("[PollInfluencerReplies] 本次轮询完成。");
    process.exit(0);
  })
  .catch((err) => {
    console.error("[PollInfluencerReplies] 轮询过程中出错:", err);
    process.exit(1);
  });

