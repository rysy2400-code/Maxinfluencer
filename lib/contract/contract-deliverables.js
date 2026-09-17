/**
 * 用 LLM 生成合同中的「Deliverables」条款正文。
 *
 * 业务口径（已确认）：
 * - 以 campaign 的 deliverables 字段为参考基线；
 * - 以红人实际邮件记录中确认的内容为准；
 * - 若执行行上有结构化「最新交付结果」（quote_negotiation[].deliverables），
 *   平台与交付项由它确定性生成，LLM 只补时间线，避免平台/交付项被改写或遗漏；
 * - 「时间沟通情况」也写进这一栏（发布时间窗口、截止、草稿审核节点等）；
 * - 必须写明发布渠道，且只能用 confirmedPlatforms 里确认过的平台；
 * - **只能用本次 campaign / 本品牌相关的信息**（靠 prompt 强约束，不做数据层过滤：
 *   红人来信多数没有 campaignId，过滤会误伤本 campaign 的往来邮件）；
 * - 不写费用、付款、权利归属、平台服务费、赛事奖金（由固定条款模块负责）；
 * - 不写画幅比例等未经品牌明确确认的细节。
 */
import { callDeepSeekLLM } from "../utils/llm-client.js";
import {
  normalizeDeliverables,
  renderDeliverablesClauseEn,
} from "../execution/deliverables-resolution.js";

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
 *   confirmedDeliverables?: object|null,
 *   confirmedPlatforms?: string[]|null,
 * }} opts
 * @returns {Promise<string>}
 */
export async function generateContractDeliverablesText({
  campaign,
  execution,
  campaignId = null,
  creator,
  conversationHistory,
  confirmedDeliverables = null,
  confirmedPlatforms = null,
}) {
  const digest = buildConversationDigest(
    pickConversationEmails(conversationHistory).slice(-MAX_MESSAGES)
  );

  const deliverables = normalizeDeliverables(confirmedDeliverables);
  const platformList =
    Array.isArray(confirmedPlatforms) && confirmedPlatforms.length
      ? confirmedPlatforms
      : deliverables?.platforms?.length
        ? deliverables.platforms
        : creator?.platform
          ? [creator.platform]
          : [];
  const deterministicClause = renderDeliverablesClauseEn(deliverables, {
    productName: campaign?.productName ?? null,
  });

  const context = {
    campaignId: campaign?.campaignId ?? campaignId ?? null,
    brandName: campaign?.brandName ?? null,
    productName: campaign?.productName ?? null,
    productLink: campaign?.productLink ?? null,
    // 参考基线：campaign 配置的交付结果字段
    campaignDeliverablesField: campaign?.deliverables ?? null,
    campaignPublishTimeRange: campaign?.publishTimeRange ?? null,
    campaignPlatforms: campaign?.platforms ?? null,
    confirmedPlatforms: platformList,
    confirmedDeliverables: deliverables,
    confirmedDeliverablesText: deterministicClause || null,
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

  // 已有结构化交付结果：平台/条数/时效由确定性文本保证，LLM 只补「发布窗口/截止/审核节点」。
  if (deterministicClause) {
    const timelineRaw = await callDeepSeekLLM(
      [
        {
          role: "user",
          content: `Context (JSON):\n${JSON.stringify(context, null, 2)}\n\nOutput ONLY the timeline addition.`,
        },
      ],
      buildTimelineSystemPrompt(context)
    );
    const timeline = sanitizeClause(timelineRaw);
    const timelineText =
      !timeline || /^none\.?$/i.test(timeline) ? "" : timeline;
    const merged = timelineText
      ? `${deterministicClause} ${timelineText}`
      : deterministicClause;
    return merged.slice(0, 1200);
  }

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
- Always state the channel(s) where the content will be published, using ONLY the platforms listed in confirmedPlatforms. If confirmedPlatforms is empty, fall back to creatorPlatform.
- NEVER introduce a platform that is not in confirmedPlatforms (or creatorPlatform when confirmedPlatforms is empty). The creator's account platform is not automatically the publishing scope of this campaign.
- Cover EVERY item in campaignDeliverablesField (for example video count, bio link duration, ad code duration, usage-rights duration). Do not drop an item for brevity.
- Also summarize the timeline actually communicated in the emails (publish window / deadline / draft submission and approval steps) inside this same clause.
- If the emails state an approximate or target publish window, keep it as communicated (for example, "around September 15") instead of making it more precise.
- If the context requires the Creator to share a draft before publishing, describe that requirement in your own words based on the conversation record; do not copy any fixed sentence from these instructions.
- Do NOT state any internal approval dates (for example, the date a script or concept was approved internally).
- Include only what is supported by the provided context. Never invent details, numbers, dates, or promises.
- Do NOT restate the aspect ratio or any format detail that is not explicitly confirmed in the context.
- Do NOT mention fees, payment, taxes, platform service fees, or contest prizes.
- Write at most 4 sentences and at most 900 characters of plain, formal English. No markdown, no bullet points, no headings, no JSON, no quotes around the whole text.
- Refer to the parties as "the Creator" and "the Agency".`;

  const userContent = `Context (JSON):
${JSON.stringify(context, null, 2)}

Output ONLY the Deliverables clause text in English.`;

  const raw = await callDeepSeekLLM([{ role: "user", content: userContent }], systemPrompt);
  return sanitizeClause(raw);
}

function sanitizeClause(raw) {
  return String(raw || "")
    .replace(/^```[a-z]*\s*/i, "")
    .replace(/```\s*$/, "")
    .replace(/\*\*/g, "")
    .replace(/^[-*]\s+/gm, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** 结构化交付结果已在正文中给出时，LLM 只负责时间线部分 */
function buildTimelineSystemPrompt(context) {
  return `You are the contract assistant for Binfluencer, an influencer talent agency.
The "Deliverables" clause already states the deliverables themselves (video count, platforms, bio link, ad code, usage rights). You must write ONLY the timeline addition to that clause.

Rules:
- This contract is only about ONE campaign: campaignId = ${
    context?.campaignId ?? "(unknown)"
  }, brandName = ${context?.brandName ?? "(unknown)"}, productName = ${
    context?.productName ?? "(unknown)"
  }.
- Include the publish window / deadline / draft submission and approval steps that were actually communicated in the emails for THIS campaign, in 1-2 sentences and at most 400 characters.
- Use ONLY information that belongs to this campaign / this brand. Ignore messages about other brands, other campaigns or other deliverables in the conversationDigest.
- Do NOT restate the deliverables themselves (platforms, video count, bio link days, ad code days, usage-rights days).
- Do NOT mention fees, payment, taxes, platform service fees, or contest prizes.
- Do NOT state any internal approval date.
- Do NOT invent details, numbers or dates.
- Plain formal English only. No markdown, no bullet points, no headings, no JSON, no quotes.
- If the emails define no timeline at all, output exactly: NONE
- Refer to the parties as "the Creator" and "the Agency".`;
}
