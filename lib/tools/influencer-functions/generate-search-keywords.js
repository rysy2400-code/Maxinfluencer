/**
 * 函数1: 生成搜索关键词
 * 基于产品数据、Campaign 数据和红人画像数据，生成适合在目标平台搜索红人的关键词列表。
 */

import { callDeepSeekLLM } from "../../utils/llm-client.js";
import {
  languageDisplayName,
  resolvePrimaryLanguageFromCampaign,
} from "../../influencer/country-primary-language.js";
import {
  normalizePlatformSlug,
  platformFromPayloadSlug,
  resolveCampaignPlatforms,
} from "../../influencer/resolve-campaign-platforms.js";

const PLATFORM_KEYWORD_HINTS = Object.freeze({
  tiktok: [
    "关键词宜短小、口语化，贴合 TikTok 用户真实搜索习惯。",
    "可使用 unboxing、review、POV、hack、测评、开箱等短视频常见表达。",
    "避免过长学术化句子，优先能直接命中热门视频标题/口播的短语。",
  ],
  instagram: [
    "关键词宜贴合 Instagram 搜索与 Reels 发现习惯，可含常见 hashtag（如 #skincareroutine）或高颜值/生活方式表达。",
    "优先 lifestyle、routine、aesthetic、OOTD、haul 等 IG 语境词汇。",
    "品类词可与 review、must have、favorite 等种草表达组合。",
  ],
  youtube: [
    "关键词可略长，偏教程/评测/对比类搜索意图。",
    "常用 best X review、X vs Y、how to choose、honest review 等频道搜索表达。",
    "适合能匹配视频标题与频道定位的检索词，而非极短 hashtag。",
  ],
});

function resolveTargetPlatformSlug(targetPlatform, campaignInfo = {}) {
  const fromParam = normalizePlatformSlug(targetPlatform);
  if (fromParam) return fromParam;
  const platforms = resolveCampaignPlatforms(campaignInfo);
  if (platforms.length === 1) {
    const slug = normalizePlatformSlug(platforms[0]);
    if (slug) return slug;
  }
  return "tiktok";
}

function buildPlatformGuidance(targetPlatformSlug) {
  const displayName = platformFromPayloadSlug(targetPlatformSlug);
  const hints = PLATFORM_KEYWORD_HINTS[targetPlatformSlug] || PLATFORM_KEYWORD_HINTS.tiktok;
  return {
    displayName,
    hintsText: hints.map((line, idx) => `${idx + 1}. ${line}`).join("\n"),
  };
}

function buildLanguageGuidance(campaignInfo = {}) {
  const langInfo = resolvePrimaryLanguageFromCampaign(campaignInfo);
  const {
    primaryLanguage,
    languageName,
    targetCountryLabels,
    primaryCountryLabel,
    allLanguages,
    isMultiLanguage,
  } = langInfo;

  const countryText =
    targetCountryLabels.length > 0 ? targetCountryLabels.join("、") : "未指定";

  let extra = "";
  if (isMultiLanguage) {
    const otherNames = allLanguages
      .filter((code) => code !== primaryLanguage)
      .map((code) => languageDisplayName(code))
      .join("、");
    extra = `\n（多国家投放：关键词以首要市场「${primaryCountryLabel}」的本地搜索语言 ${languageName} 为主；仅在确有跨市场检索价值时可少量使用其他语言如 ${otherNames}，并在 reason 中说明。）`;
  } else if (targetCountryLabels.length > 0) {
    extra = `\n（投放国家为 ${countryText}，关键词须使用当地用户在该平台搜索时最常用的语言 ${languageName}，勿默认使用英语除非该国主流检索即为英语。）`;
  }

  return {
    primaryLanguage,
    languageName,
    countryText,
    requirementLine: `使用 ${languageName}（${primaryLanguage}）写搜索关键词。${extra}`,
  };
}

/**
 * 生成搜索关键词
 * @param {Object} params
 * @param {Object} params.productInfo       产品信息
 * @param {Object} params.campaignInfo      Campaign 信息
 * @param {Object} params.influencerProfile 红人画像要求
 * @param {string} params.userMessage       用户原始输入（可选）
 * @param {string} [params.targetPlatform]  目标平台 slug：tiktok | instagram | youtube
 * @returns {Promise<{success:boolean, search_queries:string[], error?:string}>}
 */
export async function generateSearchKeywords(params = {}) {
  const {
    productInfo = {},
    campaignInfo = {},
    influencerProfile = {},
    userMessage = "",
    excludeKeywordsRun = [],
    historyTopPatterns = [],
    historyAvoidPatterns = [],
    mainGenerateCount = 12,
    bucketTargets = {
      product: 3,
      category: 3,
      competitor: 2,
      influencer_audience: 2,
      target_audience: 2,
    },
    explorationRatio = 0.3,
    forbiddenBrandTerms = [],
    keywordStrategy = "",
    targetPlatform = null,
  } = params;

  const startTime = Date.now();
  const targetPlatformSlug = resolveTargetPlatformSlug(targetPlatform, campaignInfo);
  const { displayName: platformDisplayName, hintsText: platformHintsText } =
    buildPlatformGuidance(targetPlatformSlug);
  const { primaryLanguage, languageName, countryText, requirementLine } =
    buildLanguageGuidance(campaignInfo);

  console.log("[generateSearchKeywords] 开始生成搜索关键词...");
  console.log("[generateSearchKeywords] 目标平台:", platformDisplayName, `(${targetPlatformSlug})`);
  console.log("[generateSearchKeywords] 产品信息:", JSON.stringify(productInfo, null, 2));
  console.log("[generateSearchKeywords] Campaign 信息:", JSON.stringify(campaignInfo, null, 2));
  console.log("[generateSearchKeywords] 红人画像要求:", JSON.stringify(influencerProfile, null, 2));
  console.log("[generateSearchKeywords] 用户消息:", userMessage || "(无)");
  console.log(
    `[generateSearchKeywords] 目标语言: ${languageName} (${primaryLanguage}), 投放国家: ${countryText}`
  );

  try {
    const excludeList = Array.isArray(excludeKeywordsRun)
      ? excludeKeywordsRun.filter((x) => typeof x === "string" && x.trim()).slice(0, 100)
      : [];
    const topPatterns = Array.isArray(historyTopPatterns)
      ? historyTopPatterns.slice(0, 12)
      : [];
    const avoidPatterns = Array.isArray(historyAvoidPatterns)
      ? historyAvoidPatterns.slice(0, 12)
      : [];
    const brandTerms = Array.isArray(forbiddenBrandTerms)
      ? forbiddenBrandTerms.filter((x) => typeof x === "string" && x.trim())
      : [];
    const expectedExplorationCount = Math.max(
      0,
      Math.round(Number(mainGenerateCount || 12) * Number(explorationRatio || 0))
    );

    const prompt = `你是一名红人营销专家，请基于以下信息，为 **${platformDisplayName}** 平台生成搜索红人的关键词。

【目标平台检索习惯（必须遵循）】
${platformHintsText}

【投放国家】
${countryText || "未指定"}

【产品信息】
${JSON.stringify(productInfo, null, 2)}

【Campaign 信息】
${JSON.stringify(campaignInfo, null, 2)}

【红人画像要求】
${JSON.stringify(influencerProfile, null, 2)}

【用户原话】
${userMessage || "(无)"}

【用户关键词策略（优先遵循）】
${keywordStrategy || "(未设置)"}
${keywordStrategy && /竞品|竞争|对手|competitor|rival|brand/i.test(keywordStrategy) ? "\n（策略强调竞品方向：必须产出足量的 competitor bucket 关键词，包含可对标的品牌名/品类竞品检索词，勿仅用单个泛泛 product 词敷衍。）\n" : ""}

【运行期排除关键词（同 run_id，禁止重复）】
${JSON.stringify(excludeList, null, 2)}

【历史高质量关键词模式（参考，不要照抄）】
${JSON.stringify(topPatterns, null, 2)}

【历史低质量关键词模式（尽量避开）】
${JSON.stringify(avoidPatterns, null, 2)}

【禁止出现的品牌词（仅作为生成约束）】
${JSON.stringify(brandTerms, null, 2)}

【输出要求】
1. ${requirementLine}
2. 关键词形态须适配 ${platformDisplayName} 的搜索框与内容发现习惯（见上方平台检索习惯）。
3. 必须返回 ${Number(mainGenerateCount || 12)} 条关键词，字段名为 search_queries（数组）。
4. 每个元素必须是对象，字段包含：
   - keyword: string
   - bucket: "product" | "category" | "competitor" | "influencer_audience" | "target_audience"
   - is_exploration: boolean
   - reason: string（简短）
5. bucket 数量配比必须严格等于：
${JSON.stringify(bucketTargets, null, 2)}
6. is_exploration=true 的数量目标约为 ${expectedExplorationCount}（占比 ${(Number(explorationRatio || 0) * 100).toFixed(0)}%）。
7. 不要输出包含禁止品牌词的关键词。
8. 不要输出与排除关键词相同或仅轻微改写的关键词。
9. 若用户关键词策略要求「竞品/竞争对手」相关检索，competitor bucket 的关键词必须体现竞品品牌或同类对标产品检索意图，不得全部落在 product。
10. 只返回 JSON，格式示例：
{
  "search_queries": [
    {
      "keyword": "pool robot cleaner demo",
      "bucket": "product",
      "is_exploration": false,
      "reason": "..."
    }
  ]
}`;

    const systemPrompt =
      "你是一个专业的红人营销专家，擅长为社交媒体红人搜索生成关键词。只返回严格的 JSON 字符串，不要任何解释。";

    console.log(
      `[generateSearchKeywords] Prompt 长度: ${prompt.length.toLocaleString()} 字符`
    );

    const llmStartTime = Date.now();
    const llmResult = await callDeepSeekLLM(
      [{ role: "user", content: prompt }],
      systemPrompt,
      { returnFullResponse: true }
    );
    const llmEndTime = Date.now();

    const llmResponse = llmResult.content || llmResult;
    const usage = llmResult.usage || {};

    console.log(
      `[generateSearchKeywords] LLM 调用耗时: ${(
        (llmEndTime - llmStartTime) /
        1000
      ).toFixed(2)} 秒`
    );
    console.log(
      `[generateSearchKeywords] LLM 响应长度: ${llmResponse.length.toLocaleString()} 字符`
    );
    if (usage.prompt_tokens || usage.completion_tokens) {
      console.log(
        `[generateSearchKeywords] Token 使用: 输入=${usage.prompt_tokens || "未知"}, 输出=${usage.completion_tokens || "未知"}`
      );
    }
    console.log(
      `[generateSearchKeywords] LLM 响应预览: ${llmResponse
        .substring(0, 300)
        .replace(/\s+/g, " ")}...`
    );

    let parsed;
    try {
      parsed = JSON.parse(llmResponse);
      console.log("[generateSearchKeywords] ✅ 直接解析 JSON 成功");
    } catch (e) {
      console.warn(
        "[generateSearchKeywords] 直接解析失败，尝试从文本中提取 JSON:",
        e.message
      );
      const jsonMatch = llmResponse.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        throw new Error("无法从 LLM 响应中提取 JSON");
      }
      parsed = JSON.parse(jsonMatch[0]);
      console.log(
        "[generateSearchKeywords] ✅ 从响应中提取 JSON 后解析成功"
      );
    }

    const normalizedItems = Array.isArray(parsed.search_queries)
      ? parsed.search_queries
          .map((item) => {
            if (typeof item === "string") {
              return {
                keyword: item.trim(),
                bucket: "product",
                is_exploration: false,
                reason: "",
              };
            }
            if (!item || typeof item !== "object") return null;
            const keyword = String(item.keyword || "").trim();
            if (!keyword) return null;
            return {
              keyword,
              bucket: String(item.bucket || "product").trim(),
              is_exploration: Boolean(item.is_exploration),
              reason: String(item.reason || "").trim(),
            };
          })
          .filter(Boolean)
      : [];
    const searchQueries = normalizedItems.map((x) => x.keyword);

    const endTime = Date.now();
    console.log(
      `[generateSearchKeywords] ✅ 关键词生成成功，数量: ${
        searchQueries.length
      }，总耗时: ${((endTime - startTime) / 1000).toFixed(2)} 秒`
    );
    searchQueries.forEach((q, idx) => {
      console.log(`[generateSearchKeywords]   ${idx + 1}. ${q}`);
    });

    return {
      success: true,
      search_queries: searchQueries,
      search_query_items: normalizedItems,
      targetPlatform: targetPlatformSlug,
    };
  } catch (error) {
    const endTime = Date.now();
    console.error(
      "[generateSearchKeywords] ❌ 关键词生成失败:",
      error?.message || error
    );
    console.error("[generateSearchKeywords] 错误堆栈:", error?.stack);
    console.error(
      `[generateSearchKeywords] 失败前耗时: ${(
        (endTime - startTime) /
        1000
      ).toFixed(2)} 秒`
    );

    return {
      success: false,
      search_queries: [],
      error: error?.message || String(error),
    };
  }
}
