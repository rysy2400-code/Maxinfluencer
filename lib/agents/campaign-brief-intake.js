import { callDeepSeekLLM } from "../utils/llm-client.js";

const CAMPAIGN_FIELDS = [
  "platform",
  "region",
  "publishTimeRange",
  "budget",
  "commission",
  "influencerPricing",
  "deliverables",
];
const PROFILE_FIELDS = ["followerRange", "viewRange", "videoDuration", "accountType"];

function parseJsonObject(value) {
  if (!value || typeof value !== "string") return {};
  try {
    return JSON.parse(value);
  } catch {
    const match = value.match(/\{[\s\S]*\}/);
    if (!match) return {};
    try {
      return JSON.parse(match[0]);
    } catch {
      return {};
    }
  }
}

function pickExplicitFields(value, fields) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    fields
      .filter((field) => value[field] !== null && value[field] !== undefined && value[field] !== "")
      .map((field) => [field, value[field]])
  );
}

function mergeFieldSources(previous, block, extracted, sourceText) {
  const next = { ...(previous || {}) };
  for (const field of Object.keys(extracted)) {
    next[`${block}.${field}`] = {
      sourceText,
      capturedAt: new Date().toISOString(),
    };
  }
  return next;
}

/**
 * Extract information supplied ahead of the current workflow stage. Only explicit,
 * unambiguous values are promoted into context; uncertain values retain their quote.
 */
export async function prefillCampaignBrief(messages, context = {}) {
  const lastUserMessage = [...messages].reverse().find((message) => message?.role === "user");
  const sourceText = String(lastUserMessage?.content || "").trim();
  if (!sourceText) return context;

  const prompt = `从用户本轮消息中提取创建 Campaign 时明确提供的信息。用户可能提前提供后续阶段的信息。

用户原文：
${sourceText}

规则：
1. 只提取用户明确说出的值，禁止根据行业常识、产品或上下文猜测。
2. 不明确、存在多个解释、单位不清或无法确定归属的内容不要填入字段，放入 ambiguities，并保留原文片段。
3. 没提到的字段必须返回 null。
4. platform 仅可为 TikTok、Instagram、YouTube、X（Twitter），可多选。
5. region 可多选；budget 为美元数字；commission 为百分比数字。
6. 红人粉丝量、播放量、账户类型保持用户原意。用户明确说“不限/无要求”时填“无要求”。
7. 不提取产品页面内容，也不生成内容脚本。

只返回 JSON：
{
  "campaignInfo": {
    "platform": ["TikTok"] | null,
    "region": ["美国"] | null,
    "publishTimeRange": "时间范围" | null,
    "budget": 10000 | null,
    "commission": 15 | null,
    "influencerPricing": { "mode": "ecpm_with_cap" | "commission_only", "ecpmUsd": 3 | null, "maxFlatFeeUsd": 1000 | null } | null,
    "deliverables": "明确交付要求" | null
  },
  "influencerProfile": {
    "followerRange": "用户原意" | null,
    "viewRange": "用户原意" | null,
    "videoDuration": "用户原意（如长视频教程 30-60 分钟）" | null,
    "accountType": "用户原意" | null
  },
  "ambiguities": [
    { "block": "campaignInfo" | "influencerProfile", "field": "字段名", "quote": "原文片段", "reason": "不确定原因" }
  ]
}`;

  try {
    const response = await callDeepSeekLLM(
      [{ role: "user", content: prompt }],
      "你是严谨的信息提取器。只返回 JSON；不确定时保留原文并拒绝猜测。"
    );
    const parsed = parseJsonObject(response);
    const campaignInfo = pickExplicitFields(parsed.campaignInfo, CAMPAIGN_FIELDS);
    const influencerProfile = pickExplicitFields(parsed.influencerProfile, PROFILE_FIELDS);
    const ambiguities = Array.isArray(parsed.ambiguities)
      ? parsed.ambiguities.filter((item) => item && item.field && item.quote)
      : [];

    if (!Object.keys(campaignInfo).length && !Object.keys(influencerProfile).length && !ambiguities.length) {
      return context;
    }

    const previousBrief = context.briefIntake || {};
    return {
      ...context,
      ...(Object.keys(campaignInfo).length
        ? { campaignInfo: { ...(context.campaignInfo || {}), ...campaignInfo } }
        : {}),
      ...(Object.keys(influencerProfile).length
        ? { influencerProfile: { ...(context.influencerProfile || {}), ...influencerProfile } }
        : {}),
      briefIntake: {
        ...previousBrief,
        fieldSources: mergeFieldSources(
          mergeFieldSources(previousBrief.fieldSources, "campaignInfo", campaignInfo, sourceText),
          "influencerProfile",
          influencerProfile,
          sourceText
        ),
        ambiguities: [
          ...(previousBrief.ambiguities || []),
          ...ambiguities.map((item) => ({ ...item, sourceText })),
        ].slice(-50),
      },
    };
  } catch (error) {
    console.warn("[CampaignBriefIntake] 预解析失败，继续使用已有上下文:", error);
    return context;
  }
}
