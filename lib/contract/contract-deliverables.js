/**
 * 用 LLM 生成合同中的「Deliverables」条款正文。
 *
 * 业务口径（已确认）：
 * - 以 campaign 的 deliverables 字段为参考基线；
 * - 以红人实际邮件记录中确认的内容为准；
 * - 「时间沟通情况」也写进这一栏（发布时间窗口、截止、草稿审核节点等）；
 * - 必须写明发布渠道（红人自己的平台频道）；
 * - **只能用本次 campaign / 本品牌相关的信息**（靠 prompt 强约束，不做数据层过滤：
 *   红人来信多数没有 campaignId，过滤会误伤本 campaign 的往来邮件）；
 * - 不写费用、付款、权利归属、平台服务费、赛事奖金（由固定条款模块负责）；
 * - 不写画幅比例等未经品牌明确确认的细节。
 */
import { callDeepSeekLLM } from "../utils/llm-client.js";

const MAX_MESSAGES = 30;
const MAX_CHARS_PER_MESSAGE = 1400;

/** 只保留真实往来邮件（去掉系统动作/状态更新），并按时间正序（不截断）。 */
function pickConversationEmails(history) {
  const rows = Array.isArray(history) ? history : [];
  return rows
    .filter((m) => {
      const et = String(m?.eventType || "");
      const body = String(m?.bodyText || "").trim();
      if (!body) return false;
      if (et === "email_inbound" || et === "email_outbound") return true;
      // 兼容 eventType 缺失但 direction 明确的记录
      const dir = String(m?.direction || "");
      return !et && (dir === "bin" || dir === "influencer");
    })
    .sort((a, b) => {
      const ta = new Date(a?.sentAt || a?.eventTime || a?.createdAt || 0).getTime();
      const tb = new Date(b?.sentAt || b?.eventTime || b?.createdAt || 0).getTime();
      return ta - tb;
    });
}

function buildConversationDigest(list) {
  return (Array.isArray(list) ? list : []).map((m) => {
    const who = String(m?.direction || "") === "influencer" ? "Creator" : "Bin (Agency)";
    const at = m?.sentAt || m?.eventTime || m?.createdAt || "";
    const body = String(m?.bodyText || "").slice(0, MAX_CHARS_PER_MESSAGE);
    return `--- ${at} | ${who} ---\n${body}`;
  });
}

/**
 * @param {{
 *   campaign: { campaignId?: string|null, brandName?: string|null, productName?: string|null, productLink?: string|null, deliverables?: string|null, publishTimeRange?: string|null, platforms?: string[]|null },
 *   execution?: { stage?: string|null, videoDraft?: any, videoLink?: string|null, lastEvent?: any },
 *   campaignId?: string|null,
 *   creator?: { platform?: string|null, handle?: string|null },
 *   conversationHistory?: Array<any>,
 * }} opts
 * @returns {Promise<string>}
 */
export async function generateContractDeliverablesText({
  campaign,
  execution,
  campaignId = null,
  creator,
  conversationHistory,
}) {
  const digest = buildConversationDigest(
    pickConversationEmails(conversationHistory).slice(-MAX_MESSAGES)
  );

  const context = {
    campaignId: campaign?.campaignId ?? campaignId ?? null,
    brandName: campaign?.brandName ?? null,
    productName: campaign?.productName ?? null,
    productLink: campaign?.productLink ?? null,
    // 参考基线：campaign 配置的交付结果字段
    campaignDeliverablesField: campaign?.deliverables ?? null,
    campaignPublishTimeRange: campaign?.publishTimeRange ?? null,
    campaignPlatforms: campaign?.platforms ?? null,
    creatorPlatform: creator?.platform ?? null,
    creatorHandle: creator?.handle ?? null,
    execution: {
      stage: execution?.stage ?? null,
      videoDraft: execution?.videoDraft ?? null,
      videoLink: execution?.videoLink ?? null,
      contentBrief: execution?.lastEvent?.contentBrief ?? null,
      scriptApprovedAt: execution?.lastEvent?.scriptApprovedAt ?? null,
      scriptApprovedLink: execution?.lastEvent?.scriptApprovedLink ?? null,
    },
    conversationDigest: digest,
  };

  const systemPrompt = `You are the contract assistant for Binfluencer, an influencer talent agency.
Write the "Deliverables" clause of an English collaboration agreement between Binfluencer (the Agency) and the creator (the Creator).

Rules:
- THIS CONTRACT IS ONLY ABOUT THIS ONE CAMPAIGN. The campaign is defined by: campaignId = ${
    campaign?.campaignId ?? campaignId ?? "(unknown)"
  }, brandName = ${campaign?.brandName ?? "(unknown)"}, productName = ${
    campaign?.productName ?? "(unknown)"
  }, productLink = ${campaign?.productLink ?? "(none)"}.
- Use ONLY information that belongs to this campaign / this brand. The conversationDigest may contain messages from OTHER collaborations of the same creator (for example other brands, other campaigns, other deliverables). Ignore all of them completely.
- NEVER mention any other brand name, product name, campaign id, deliverable count, date, window, or requirement that belongs to another collaboration. If a detail cannot be attributed to THIS campaign / THIS brand, leave it out.
- Base the deliverables on the campaign's configured deliverables field, but the creator's actual email record takes precedence wherever it confirms something more specific (e.g. an approved script/concept title, final duration, publish window, hard deadline, draft-review step).
- Always state the channel where the video will be published, using the creator's own platform (for example: "on the Creator's Instagram channel"). Use the creatorPlatform value provided; never substitute a different platform.
- Also summarize the timeline actually communicated in the emails (publish window / deadline / draft submission and approval steps) inside this same clause.
- If the emails state an approximate or target publish window, keep it as communicated (for example, "around September 15") instead of making it more precise.
- If the context requires the Creator to share a draft before publishing, describe that requirement in your own words based on the conversation record; do not copy any fixed sentence from these instructions.
- Do NOT state any internal approval dates (for example, the date a script or concept was approved internally).
- Include only what is supported by the provided context. Never invent details, numbers, dates, or promises.
- Do NOT restate the aspect ratio or any format detail that is not explicitly confirmed in the context.
- Do NOT mention fees, payment, taxes, platform service fees, rights/usage, or contest prizes.
- Write at most 3 sentences and at most 600 characters of plain, formal English. No markdown, no bullet points, no headings, no JSON, no quotes around the whole text.
- Refer to the parties as "the Creator" and "the Agency".`;

  const userContent = `Context (JSON):
${JSON.stringify(context, null, 2)}

Output ONLY the Deliverables clause text in English.`;

  const raw = await callDeepSeekLLM([{ role: "user", content: userContent }], systemPrompt);
  return String(raw || "")
    .replace(/^```[a-z]*\s*/i, "")
    .replace(/```\s*$/, "")
    .replace(/\*\*/g, "")
    .replace(/^[-*]\s+/gm, "")
    .replace(/\s+/g, " ")
    .trim();
}
