/**
 * 向「法国 RELX prime」campaign 已联系的 28 位红人补发产品链接更正邮件。
 *
 * 用法：
 *   node scripts/send-product-link-correction-emails.mjs --dry-run   # 预览，不发送
 *   node scripts/send-product-link-correction-emails.mjs             # 真实发送
 */
import { queryTikTok } from "../lib/db/mysql-tiktok.js";
import { sendMail } from "../lib/email/enterprise-mail-client.js";
import { logConversationMessage } from "../lib/db/influencer-conversation-dao.js";
import { getInfluencerById } from "../lib/db/influencer-dao.js";
import { resolveInfluencerThreadMailContext } from "../lib/email/influencer-thread-mail.js";

const CAMPAIGN_ID = "CAMP-1786935898068-SNXGL7C8K";
const NEW_LINK = "https://relxnow.fr/";
const DRY_RUN = process.argv.includes("--dry-run");

const rows = await queryTikTok(
  `SELECT influencer_id, to_email, message_id, subject
   FROM tiktok_influencer_conversation_messages
   WHERE campaign_id = ? AND direction = 'bin' AND channel = 'email'
   ORDER BY created_at DESC`,
  [CAMPAIGN_ID]
);

const seen = new Set();
const recipients = [];
for (const r of rows) {
  if (!r.influencer_id || seen.has(r.influencer_id)) continue;
  seen.add(r.influencer_id);
  recipients.push(r);
}

console.log(
  `${DRY_RUN ? "[DRY-RUN] 预览" : "[SendCorrection]"} 待补发红人数: ${recipients.length}`
);

let sent = 0;
let failed = 0;

for (const r of recipients) {
  const influencer = await getInfluencerById(r.influencer_id);
  const name =
    influencer?.displayName ||
    influencer?.username ||
    r.to_email.split("@")[0] ||
    "Creator";
  const body = `Hi ${name},

Quick correction to my previous email about the RELX Prime collaboration: the product link I shared earlier was incorrect.

The correct link is: ${NEW_LINK}

The collaboration is for RELX Prime by RELX, and everything else from my previous message remains the same. Please use the new link above, and apologies for any confusion.

Best,
Bin`;

  let ctx;
  try {
    ctx = await resolveInfluencerThreadMailContext({
      influencerId: r.influencer_id,
      influencer,
      preferredInReplyToMessageId: r.message_id || null,
      campaignId: CAMPAIGN_ID,
    });
  } catch (err) {
    console.error(`[SendCorrection] 解析线程上下文失败 ${r.influencer_id}:`, err?.message);
    failed++;
    continue;
  }

  const subject = ctx.subjectForSend;
  if (DRY_RUN) {
    console.log("--------------------------------------------------");
    console.log(`收件人: ${r.to_email} (${r.influencer_id})`);
    console.log(`发件账号: ${ctx.fromAccount.email || ctx.fromAccount.username || ""}`);
    console.log(`主题: ${subject}`);
    console.log(`In-Reply-To: ${ctx.inReplyTo || "无"}`);
    console.log(body);
    continue;
  }

  const headers = {
    "X-Maxin-Influencer-Id": r.influencer_id,
    "X-Maxin-Campaign-Id": CAMPAIGN_ID,
    "X-Maxin-Source": "ProductLinkCorrection",
  };
  if (ctx.inReplyTo) headers["In-Reply-To"] = ctx.inReplyTo;
  if (ctx.references) headers["References"] = ctx.references;

  let result = null;
  let sendErr = null;
  try {
    result = await sendMail({
      fromAccount: ctx.fromAccount,
      to: r.to_email,
      subject,
      text: body,
      headers,
    });
  } catch (err) {
    sendErr = err;
  }

  if (sendErr) {
    console.error(`[SendCorrection] 发送失败 ${r.to_email}:`, sendErr?.message);
    failed++;
    continue;
  }

  try {
    await logConversationMessage({
      influencerId: r.influencer_id,
      campaignId: CAMPAIGN_ID,
      direction: "bin",
      channel: "email",
      fromEmail: ctx.fromAccount.email || ctx.fromAccount.username || null,
      toEmail: r.to_email,
      subject,
      bodyText: body,
      messageId: result?.messageId || null,
      sourceType: "product_link_correction",
      sourceEventTable: null,
      sourceEventId: null,
      sentAt: new Date(),
      eventType: "email_outbound",
      eventTime: new Date(),
      actorType: "agent",
      sendMode: "auto_send",
      contentOrigin: "system_correction",
      traceId: null,
      payload: {
        kind: "product_link_correction",
        status: "succeeded",
        correctLink: NEW_LINK,
        email: { to: r.to_email, subject, messageId: result?.messageId || null },
      },
    });
  } catch (err) {
    console.error(
      `[SendCorrection] 写入对话记录失败 ${r.to_email}:`,
      err?.message
    );
  }

  sent++;
  console.log(`[SendCorrection] 已发送 ${sent}/${recipients.length}: ${r.to_email}`);

  // 温和限速，避免 SMTP 限流
  if (sent < recipients.length) {
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
}

console.log(
  `${DRY_RUN ? "[DRY-RUN] 预览完成" : "[SendCorrection] 完成"}: 成功 ${sent}，失败 ${failed}，共 ${recipients.length}`
);
process.exit(failed > 0 && !DRY_RUN ? 1 : 0);
