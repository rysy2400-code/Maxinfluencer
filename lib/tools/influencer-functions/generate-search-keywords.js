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

【输出要求】
1. 使用 ${languageName}（${primaryLanguage}）写搜索关键词。
2. 返回 5~8 个搜索查询，字段名为 search_queries（数组）。
3. 关键词要尽量包含产品词 / 品牌词 / 类目词，让平台更容易找到相关红人。
4. 关键词适合直接在 TikTok / Instagram 搜索框中使用，例如：
   - "lululemon fashion influencer"
   - "high waist wide leg pants tiktok review"
   - "athleisure outfit influencer"
5. 只返回 JSON，格式示例：
{
  "search_queries": ["keyword1", "keyword2"]
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

    const searchQueries = Array.isArray(parsed.search_queries)
      ? parsed.search_queries.filter((q) => typeof q === "string" && q.trim())
      : [];

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


