import { getInfluencerById } from "../db/influencer-dao.js";
import { queryTikTok } from "../db/mysql-tiktok.js";
import {
  getOutboundAccountForInfluencer,
  sendMail,
} from "../email/enterprise-mail-client.js";
import { logConversationMessage } from "../db/influencer-conversation-dao.js";
import { callDeepSeekLLM } from "../utils/llm-client.js";
import { influencerAgentBasePrompt } from "./influencer-agent-prompt.js";

/**
 * 从红人信息中提取邮箱（MVP 规则）
 * - 优先 contacts.email
 * - 其次 contacts.emails[0]
 */
function pickInfluencerEmail(influencer) {
  const contacts = influencer?.contacts || {};
  if (typeof contacts.email === "string" && contacts.email.includes("@")) {
    return contacts.email;
  }
  if (Array.isArray(contacts.emails)) {
    const found = contacts.emails.find(
      (e) => typeof e === "string" && e.includes("@")
    );
    if (found) return found;
  }
  return null;
}

/**
 * 生成首封合作邮件的标题（统一 Binfluencer 线程标题）
 */
function buildOutreachSubject(campaign, influencer) {
  const name = influencer?.displayName || influencer?.username || "Creator";
  return `Binfluencer x ${name} | Social Media Collaboration`;
}

function getPlatformLabel(campaign) {
  const platforms = campaign?.campaignInfo?.platforms;
  if (Array.isArray(platforms) && platforms.length) {
    const uniq = [
      ...new Set(
        platforms
          .map((p) => (p == null ? "" : String(p).trim()))
          .filter(Boolean)
      ),
    ];
    if (!uniq.length) return "social media";
    if (uniq.length === 1) return uniq[0];
    return uniq.join(" / ");
  }
  return "social media";
}

export async function loadConversationHistoryForInfluencer(influencerId, limit = 20) {
  if (!influencerId) return [];
  const n = Math.min(50, Math.max(1, Number(limit) || 20));
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
    ORDER BY COALESCE(sent_at, created_at) DESC
    LIMIT ${n}
  `,
    [influencerId]
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

async function generateOutreachBodyWithLLM({ campaign, influencer, conversationHistory }) {
  const brand =
    campaign?.productInfo?.brand ||
    campaign?.campaignInfo?.brand ||
    "our brand partner";
  const product = campaign?.productInfo?.product || "your product";
  const productLink = campaign?.productInfo?.productLink || "";
  const name = influencer?.displayName || influencer?.username || "Creator";
  const platformLabel = getPlatformLabel(campaign);

  const systemPrompt = `
${influencerAgentBasePrompt}

【当前任务：首封邀约邮件】
- 给指定红人写一封「首封」或「本轮机会」的邀约邮件正文，风格自然、像一对一沟通，而不是群发模板。
- 邮件标题（subject）固定由系统统一设置为 "Binfluencer x <CreatorName> | Social Media Collaboration"，你不要设计或输出标题，只负责正文内容。
- 用英文写邮件正文（纯文本，不要 markdown，不要 JSON）。
- 语气：专业、友好、简洁，不要太推销感。
- 不要逐条罗列 bullet point，保持自然段落。
- 适当根据 conversationHistory 判断：
  - 如果之前已经联系过同一个红人，可以简要提到「we talked before / nice to reconnect」之类的过往；
  - 但不要重复上一封几乎一模一样的句子。
- 主体人设一定是 Bin（代表 Binfluencer 与品牌沟通）。
`;

  const payload = {
    influencer: {
      id: influencer?.influencerId || influencer?.id || null,
      displayName: influencer?.displayName || null,
      username: influencer?.username || null,
      profileUrl: influencer?.profileUrl || null,
      country: influencer?.country || null,
    },
    campaign: {
      id: campaign?.id || null,
      brand,
      product,
      productLink,
      platformLabel,
      productInfo: campaign?.productInfo || null,
      campaignInfo: campaign?.campaignInfo || null,
    },
    conversationHistory,
  };

  const userContent = `
Below is the context for a new outreach email to a creator.

JSON input:
${JSON.stringify(payload, null, 2)}

Please output ONLY the email body in English, no greeting explanation, no JSON, no extra commentary.
`;

  const raw = await callDeepSeekLLM(
    [{ role: "user", content: userContent }],
    systemPrompt
  );

  return String(raw || "").trim();
}

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
 * 读取完整 campaign，用于邮件内容生成。
 */
async function getCampaignByIdInternal(campaignId) {
  const rows = await queryTikTok(
    "SELECT * FROM tiktok_campaign WHERE id = ?",
    [campaignId]
  );
  if (!rows || rows.length === 0) return null;
  const r = rows[0];
  return {
    id: r.id,
    productInfo: parseJsonOrObject(r.product_info),
    campaignInfo: parseJsonOrObject(r.campaign_info),
    influencerProfile: parseJsonOrObject(r.influencer_profile),
    contentScript: parseJsonOrObject(r.content_script),
  };
}

/**
 * 首轮触达：真正的发信逻辑，由 InfluencerAgent 事件 Worker 调用。
 * - 查红人邮箱
 * - 选择企业发件邮箱
 * - 生成邮件并发送
 * - 在 tiktok_campaign_execution.last_event 中记录结果
 * - 写入对话记忆表
 */
export async function sendOutreach({ campaignId, influencerId, snapshot }) {
  const influencer = await getInfluencerById(influencerId);
  if (!influencer) {
    console.warn(
      `[InfluencerAgent] 找不到红人 ${influencerId}，跳过邮件触达。`
    );
    return;
  }

  const toEmail = pickInfluencerEmail(influencer);
  if (!toEmail) {
    console.warn(
      `[InfluencerAgent] 红人 ${influencerId} 缺少邮箱联系方式，跳过邮件触达。`
    );
    return;
  }

  const campaign = await getCampaignByIdInternal(campaignId);
  const fromAccount = await getOutboundAccountForInfluencer(influencer);

  const subject = buildOutreachSubject(campaign, influencer);

  // LLM 生成正文（无模板回退）：如果调用失败，将直接抛错并由上层事件标记为失败
  const history = await loadConversationHistoryForInfluencer(influencerId, 20);
  const text = await generateOutreachBodyWithLLM({
    campaign,
    influencer,
    conversationHistory: history,
  });

  const headers = {
    "X-Maxin-Influencer-Id": influencerId,
    "X-Maxin-Campaign-Id": campaignId,
  };

  const result = await sendMail({
    fromAccount,
    to: toEmail,
    subject,
    text,
    headers,
  });

  // 记录到执行表的 last_event，方便排查
  try {
    await queryTikTok(
      `
      UPDATE tiktok_campaign_execution
      SET last_event = JSON_MERGE_PRESERVE(
            COALESCE(last_event, JSON_OBJECT()),
            JSON_OBJECT(
              'outreachEmail',
              JSON_OBJECT(
                'sentAt', ?,
                'to', ?,
                'subject', ?,
                'messageId', ?,
                'createdBy', 'InfluencerAgent'
              )
            )
          )
      WHERE campaign_id = ? AND influencer_id = ?
    `,
      [
        new Date().toISOString(),
        toEmail,
        subject,
        result?.messageId || null,
        campaignId,
        influencerId,
      ]
    );
  } catch (err) {
    console.error(
      "[InfluencerAgent] 更新 tiktok_campaign_execution.last_event 失败:",
      err
    );
  }

  // 记录我方首轮邀约到对话记忆表
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
      toEmail: toEmail,
      subject,
      bodyText: text,
      messageId: result?.messageId || null,
      sourceType: "seed_outreach",
      sourceEventTable: null,
      sourceEventId: null,
      sentAt: new Date(),
    });
  } catch (err) {
    console.error(
      "[InfluencerAgent] 写入 tiktok_influencer_conversation_messages 失败:",
      err
    );
  }
}

/**
 * 首轮触达：由执行心跳 / 种子脚本调用，只负责写入 InfluencerAgent 事件表，
 * 真正发信由 process-influencer-agent-events.js Worker 负责。
 */
export async function enqueueFirstOutreach({
  campaignId,
  influencerId,
  snapshot,
}) {
  if (!campaignId || !influencerId) {
    console.warn(
      "[InfluencerAgent] enqueueFirstOutreach 缺少 campaignId 或 influencerId，跳过。"
    );
    return;
  }

  await queryTikTok(
    `
    INSERT INTO tiktok_influencer_agent_event (
      influencer_id,
      campaign_id,
      event_type,
      payload,
      status
    ) VALUES (?, ?, 'first_outreach', ?, 'pending')
  `,
    [
      influencerId,
      campaignId,
      JSON.stringify({
        campaignId,
        influencerId,
        snapshot: snapshot || null,
        createdBy: "execution-heartbeat",
        createdAt: new Date().toISOString(),
      }),
    ]
  );
}


