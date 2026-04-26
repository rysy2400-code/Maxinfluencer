/**
 * 函数1: 生成搜索关键词
 * 基于产品数据、Campaign 数据和红人画像数据，生成适合在 TikTok / Instagram 上搜索红人的关键词列表。
 */

import { callDeepSeekLLM } from "../../utils/llm-client.js";

// 国家到语言的简单映射，用于确定提示语语言
const COUNTRY_LANGUAGE_MAP = {
  "美国": "en",
  "英国": "en",
  "德国": "de",
  "法国": "fr",
  "西班牙": "es",
  "中国": "zh",
};

/**
 * 生成搜索关键词
 * @param {Object} params
 * @param {Object} params.productInfo       产品信息
 * @param {Object} params.campaignInfo      Campaign 信息
 * @param {Object} params.influencerProfile 红人画像要求
 * @param {string} params.userMessage       用户原始输入（可选）
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
  } = params;

  const startTime = Date.now();

  console.log("[generateSearchKeywords] 开始生成搜索关键词...");
  console.log("[generateSearchKeywords] 产品信息:", JSON.stringify(productInfo, null, 2));
  console.log("[generateSearchKeywords] Campaign 信息:", JSON.stringify(campaignInfo, null, 2));
  console.log("[generateSearchKeywords] 红人画像要求:", JSON.stringify(influencerProfile, null, 2));
  console.log("[generateSearchKeywords] 用户消息:", userMessage || "(无)");

  try {
    // 1. 推断目标语言
    const countries = campaignInfo.countries || campaignInfo.region || [];
    const countryArray = Array.isArray(countries) ? countries : [countries];
    const languages = new Set();

    countryArray.forEach((country) => {
      const lang = COUNTRY_LANGUAGE_MAP[country] || "en";
      languages.add(lang);
    });

    const primaryLanguage = languages.has("en")
      ? "en"
      : Array.from(languages)[0] || "en";

    const languageName =
      primaryLanguage === "en"
        ? "英语"
        : primaryLanguage === "de"
        ? "德语"
        : primaryLanguage === "fr"
        ? "法语"
        : primaryLanguage === "es"
        ? "西班牙语"
        : "中文";

    console.log(
      `[generateSearchKeywords] 目标语言: ${languageName} (${primaryLanguage}), 目标国家: ${countryArray.join(
        ", "
      )}`
    );

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

    // 2. 构造提示词
    const prompt = `你是一名红人营销专家，请基于以下信息生成在 TikTok / Instagram 上搜索红人的关键词。

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

【运行期排除关键词（同 run_id，禁止重复）】
${JSON.stringify(excludeList, null, 2)}

【历史高质量关键词模式（参考，不要照抄）】
${JSON.stringify(topPatterns, null, 2)}

【历史低质量关键词模式（尽量避开）】
${JSON.stringify(avoidPatterns, null, 2)}

【禁止出现的品牌词（仅作为生成约束）】
${JSON.stringify(brandTerms, null, 2)}

【输出要求】
1. 使用 ${languageName}（${primaryLanguage}）写搜索关键词。
2. 必须返回 ${Number(mainGenerateCount || 12)} 条关键词，字段名为 search_queries（数组）。
3. 每个元素必须是对象，字段包含：
   - keyword: string
   - bucket: "product" | "category" | "competitor" | "influencer_audience" | "target_audience"
   - is_exploration: boolean
   - reason: string（简短）
4. bucket 数量配比必须严格等于：
${JSON.stringify(bucketTargets, null, 2)}
5. is_exploration=true 的数量目标约为 ${expectedExplorationCount}（占比 ${(Number(explorationRatio || 0) * 100).toFixed(0)}%）。
6. 不要输出包含禁止品牌词的关键词。
7. 不要输出与排除关键词相同或仅轻微改写的关键词。
8. 关键词适合直接在 TikTok / Instagram 搜索框中使用。
9. 只返回 JSON，格式示例：
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

    // 3. 调用 LLM
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

    // 4. 解析 JSON
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


