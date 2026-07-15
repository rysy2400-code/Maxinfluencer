/**
 * 函数1: 生成搜索关键词
 * 基于产品数据、Campaign 数据和红人画像数据，生成适合在目标平台搜索红人的关键词列表。
 */

import { callDeepSeekLLM } from "../../utils/llm-client.js";
import {
  ISO_PRIMARY_LANGUAGE,
  languageDisplayName,
  resolvePrimaryLanguageFromCampaign,
} from "../../influencer/country-primary-language.js";
import { resolveAllowedCountriesFromCampaign } from "../../influencer/campaign-country-codes.js";
import {
  normalizePlatformSlug,
  platformFromPayloadSlug,
  resolveCampaignPlatforms,
} from "../../influencer/resolve-campaign-platforms.js";
import { filterKeywordSignalsForSearch } from "../../influencer/extract-keyword-signals.js";
import { normalizeInstagramSearchKeyword } from "./instagram/normalize-instagram-search-keyword.js";

const PLATFORM_KEYWORD_HINTS = Object.freeze({
  tiktok: [
    "关键词宜短小、口语化，贴合 TikTok 用户真实搜索习惯。",
    "可使用 unboxing、review、POV、hack、测评、开箱等短视频常见表达。",
    "避免过长学术化句子，优先能直接命中热门视频标题/口播的短语。",
  ],
  instagram: [
    "Instagram 关键词搜索页仅支持单个 hashtag 标签检索（如 #student、#utd、#collegelife），多词短语无法返回结果。",
    "每条 keyword 必须是且仅是 1 个 hashtag：以 # 开头、无空格、仅含字母/数字/下划线（如 #collegestudent，而非 college student routine）。",
    "优先与目标受众、校园/情侣/生活方式相关的真实 IG 热门标签；可探索大学缩写（如 #utd）、品类标签（如 #datingapp）。",
    "禁止输出句子、多词短语、或不含 # 的纯文本关键词。",
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

function buildPlatformOutputExtraRequirements(targetPlatformSlug) {
  if (targetPlatformSlug !== "instagram") return "";
  return `
12. 【Instagram 专属（强制）】每条 keyword 必须是单个 hashtag 标签，格式如 #student、#collegelife；禁止空格与多词短语。
13. JSON 示例中的 keyword 字段也必须以 # 开头的单个标签形式输出。`;
}

function buildPlatformKeywordExample(targetPlatformSlug) {
  if (targetPlatformSlug === "instagram") {
    return {
      keyword: "#collegelife",
      bucket: "influencer_audience",
      is_exploration: false,
      reason: "校园生活方式热门标签，便于发现目标红人",
    };
  }
  if (targetPlatformSlug === "youtube") {
    return {
      keyword: "best pool robot cleaner review",
      bucket: "product",
      is_exploration: false,
      reason: "...",
    };
  }
  return {
    keyword: "pool robot cleaner demo",
    bucket: "product",
    is_exploration: false,
    reason: "...",
  };
}

function promptJson(value, indent = 2) {
  const pad = " ".repeat(indent);
  return JSON.stringify(value, null, 2).split("\n").join(`\n${pad}`);
}

function buildKeywordSignalsSection(keywordSignals = [], platformDisplayName = "TikTok") {
  if (!Array.isArray(keywordSignals) || keywordSignals.length === 0) return "";
  const lines = keywordSignals.map((s) => {
    const value = String(s.signal_value || s.signalValue || "").trim();
    const count = Number(s.influencer_count ?? s.influencerCount ?? 0);
    return `${value} (${count}位红人)`;
  });
  return `
【红人视频挖掘线索 — ${platformDisplayName}（候选模式，补充探索）】
以下线索来自已匹配红人视频，按红人覆盖数降序排列。
这些线索只是候选，不要求全部搜索。你需要判断每条是否明显有助于继续找到本 campaign 相关红人。
若选择使用，必须原样作为 search_queries 中的 keyword 输出（保留 # 或 @，不得改写）。

${lines.join("\n")}

【候选线索选择约束】
- 只选择与产品、目标人群、竞品、创作者垂类明显相关的线索。
- 明显无关、泛娱乐、个人大号、游戏号、排行编号、教程章节编号、或与 campaign 受众不匹配的 @mention/#tag 必须丢弃。
- 输出 selected_signal_keywords 数组记录被采用的候选线索；输出 dropped_signal_keywords 数组记录被丢弃的候选线索和简短原因。
- 不要输出与【运行期排除关键词】或【历史低质量关键词模式】冲突的词。`;
}

function enforceStrictKeywordSignals(
  normalizedItems,
  keywordSignals = [],
  targetPlatformSlug = "tiktok"
) {
  if (!Array.isArray(keywordSignals) || keywordSignals.length === 0) {
    return normalizedItems;
  }
  const existing = new Set(
    normalizedItems.map((x) => String(x.keyword || "").trim()).filter(Boolean)
  );
  const merged = [...normalizedItems];
  for (const sig of keywordSignals) {
    const raw = String(sig.signal_value || sig.signalValue || "").trim();
    const keyword =
      targetPlatformSlug === "instagram" && raw.startsWith("#")
        ? normalizeInstagramSearchKeyword(raw)
        : raw;
    if (!keyword || existing.has(keyword)) continue;
    merged.unshift({
      keyword,
      bucket: sig.signal_type === "mention" ? "competitor" : "influencer_audience",
      is_exploration: true,
      reason: "LLM 选择采用的候选信号关键词",
    });
    existing.add(keyword);
  }
  return merged;
}

function parseSelectedSignalKeywords(parsed = {}, keywordSignals = []) {
  const signalMap = new Map();
  for (const sig of keywordSignals || []) {
    const value = String(sig.signal_value || sig.signalValue || "").trim();
    if (value) signalMap.set(value.toLowerCase(), sig);
  }

  const selectedRaw = Array.isArray(parsed.selected_signal_keywords)
    ? parsed.selected_signal_keywords
    : [];
  const selected = [];
  const seen = new Set();

  for (const item of selectedRaw) {
    const value =
      typeof item === "string"
        ? item.trim()
        : String(item?.keyword || item?.signal_value || item?.signalValue || "").trim();
    const hit = signalMap.get(value.toLowerCase());
    if (!hit || seen.has(value.toLowerCase())) continue;
    selected.push(hit);
    seen.add(value.toLowerCase());
  }

  return selected;
}

function parseDroppedSignalKeywords(parsed = {}) {
  const droppedRaw = Array.isArray(parsed.dropped_signal_keywords)
    ? parsed.dropped_signal_keywords
    : [];
  return droppedRaw
    .map((item) => {
      if (typeof item === "string") {
        return { keyword: item.trim(), reason: "LLM dropped signal" };
      }
      const keyword = String(item?.keyword || item?.signal_value || item?.signalValue || "").trim();
      if (!keyword) return null;
      return {
        keyword,
        reason: String(item?.reason || item?.filter_reason || "LLM dropped signal").trim(),
      };
    })
    .filter(Boolean);
}

function buildLanguageGuidance(campaignInfo = {}) {
  const langInfo = resolvePrimaryLanguageFromCampaign(campaignInfo);
  const {
    primaryLanguage,
    languageName,
    targetCountryLabels,
    allLanguages,
    isMultiLanguage,
  } = langInfo;

  const isos = resolveAllowedCountriesFromCampaign(campaignInfo);
  const countryText =
    targetCountryLabels.length > 0 ? targetCountryLabels.join("、") : "未指定";

  const countryLanguageLines = isos.map((iso, idx) => {
    const label = targetCountryLabels[idx] || iso;
    const langCode = ISO_PRIMARY_LANGUAGE[iso] || "en";
    return `- ${label}：${languageDisplayName(langCode)}（${langCode}）`;
  });

  const allowedLanguageNames = allLanguages.map((code) => languageDisplayName(code)).join("、");

  const multiCountryNote = isMultiLanguage
    ? `投放国家为多个国家（${countryText}），每条关键词只能使用下列对应国家语言之一，禁止混用或改用其他语言：\n${countryLanguageLines.join("\n")}`
    : "";

  const singleCountryNote =
    !isMultiLanguage && targetCountryLabels.length > 0
      ? `投放国家为 ${countryText}，所有关键词必须使用 ${languageName}（${primaryLanguage}）。`
      : "";

  const languageSection = `【关键词语言（强制）】
强制要求：必须按 Campaign 信息中的投放国家（region / countries）生成对应国家本地搜索语言的关键词。
${singleCountryNote}${multiCountryNote}
- 禁止用「英语 + 国家名」冒充本地化（如 "AI assistant review Indonesia"）；非英语投放国不得输出此类关键词。
- 品牌名/产品名（如 Qwen）可保留原文，但其余检索词须为投放国本地语言。
- 探索词（is_exploration=true）与各类 bucket 均须遵守上述语言约束，无例外。`;

  const requirementLine = isMultiLanguage
    ? `所有关键词只能使用以下投放国对应语言：${allowedLanguageNames}；每条关键词选用其中一种语言，不得使用列表外语言。`
    : targetCountryLabels.length > 0
    ? `所有关键词必须使用 ${languageName}（${primaryLanguage}），不得使用其他语言。`
    : `按 Campaign 投放国家使用当地主流搜索语言撰写关键词。`;

  return {
    primaryLanguage,
    languageName,
    countryText,
    languageSection,
    requirementLine,
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
    keywordSignals = [],
  } = params;

  const startTime = Date.now();
  const targetPlatformSlug = resolveTargetPlatformSlug(targetPlatform, campaignInfo);
  const { displayName: platformDisplayName, hintsText: platformHintsText } =
    buildPlatformGuidance(targetPlatformSlug);
  const platformOutputExtra = buildPlatformOutputExtraRequirements(targetPlatformSlug);
  const platformKeywordExample = buildPlatformKeywordExample(targetPlatformSlug);
  const { primaryLanguage, languageName, countryText, languageSection, requirementLine } =
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
    const activeSignalsRaw = Array.isArray(keywordSignals)
      ? keywordSignals
          .map((s) => ({
            signal_type: s.signal_type || s.signalType || "hashtag",
            signal_value: String(s.signal_value || s.signalValue || "").trim(),
            influencer_count: Number(s.influencer_count ?? s.influencerCount ?? 0),
          }))
          .filter((s) => s.signal_value)
      : [];
    const signalFilter = filterKeywordSignalsForSearch(activeSignalsRaw);
    const activeSignals = signalFilter.kept;
    if (signalFilter.dropped.length > 0) {
      console.warn(
        `[generateSearchKeywords] 过滤候选 signal ${signalFilter.dropped.length} 条: ` +
          signalFilter.dropped
            .slice(0, 12)
            .map((s) => `${s.signal_value}:${s.filter_reason}`)
            .join(", ")
      );
    }
    const effectiveMainGenerateCount = Math.max(
      Number(mainGenerateCount || 12),
      activeSignals.length
    );
    const signalsSection = buildKeywordSignalsSection(activeSignals, platformDisplayName);
    const selectedSignalExample =
      activeSignals.length > 0
        ? [
            {
              keyword: activeSignals[0].signal_value,
              reason: "与目标创作者垂类相关",
            },
          ]
        : [];
    const droppedSignalExample =
      activeSignals.length > 1
        ? [
            {
              keyword: activeSignals[1].signal_value,
              reason: "与 campaign 不相关或过于泛化",
            },
          ]
        : [];
    const expectedExplorationCount = Math.max(
      0,
      Math.round(effectiveMainGenerateCount * Number(explorationRatio || 0))
    );

    const prompt = `你是一名红人营销专家，请基于以下信息，为 **${platformDisplayName}** 平台生成搜索红人的关键词。

【目标平台检索习惯（必须遵循）】
${platformHintsText}

【投放国家】
${countryText || "未指定"}

${languageSection}

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

【运行期排除关键词（当日 run + 近14天已搜索，禁止重复）】
${JSON.stringify(excludeList, null, 2)}

【历史高质量关键词模式（参考，不要照抄）】
${JSON.stringify(topPatterns, null, 2)}

【历史低质量关键词模式（尽量避开）】
${JSON.stringify(avoidPatterns, null, 2)}

【禁止出现的品牌词（仅作为生成约束）】
${JSON.stringify(brandTerms, null, 2)}
${signalsSection}

【输出要求】
1. ${requirementLine}
2. 严格遵守上方【关键词语言（强制）】：按投放国家使用对应国家语言；多国家投放时只生成各投放国对应语言的关键词，不得使用未列出的语言。
3. 关键词形态须适配 ${platformDisplayName} 的搜索框与内容发现习惯（见上方平台检索习惯）。
4. 必须返回 ${effectiveMainGenerateCount} 条关键词，字段名为 search_queries（数组）。
5. 每个元素必须是对象，字段包含：
   - keyword: string
   - bucket: "product" | "category" | "competitor" | "influencer_audience" | "target_audience"
   - is_exploration: boolean
   - reason: string（简短）
6. bucket 数量配比必须严格等于：
${JSON.stringify(bucketTargets, null, 2)}
7. is_exploration=true 的数量目标约为 ${expectedExplorationCount}（占比 ${(Number(explorationRatio || 0) * 100).toFixed(0)}%）。
8. 不要输出包含禁止品牌词的关键词。
9. 不要输出与排除关键词相同或仅轻微改写的关键词。
10. 若用户关键词策略要求「竞品/竞争对手」相关检索，competitor bucket 的关键词必须体现竞品品牌或同类对标产品检索意图，不得全部落在 product。${platformOutputExtra}
11. 只返回 JSON，格式示例：
{
  "selected_signal_keywords": ${promptJson(selectedSignalExample, 2)},
  "dropped_signal_keywords": ${promptJson(droppedSignalExample, 2)},
  "search_queries": [
    ${JSON.stringify(platformKeywordExample, null, 4).split("\n").join("\n    ")}
  ]
}`;

    const systemPrompt =
      targetPlatformSlug === "instagram"
        ? "你是一个专业的红人营销专家，擅长为 Instagram 红人搜索生成单个 hashtag 标签关键词。必须严格按 Campaign 投放国家使用对应国家本地语言；每条 keyword 只能是 1 个以 # 开头的标签，禁止多词短语。只返回严格的 JSON 字符串，不要任何解释。"
        : "你是一个专业的红人营销专家，擅长为社交媒体红人搜索生成关键词。必须严格按 Campaign 投放国家使用对应国家本地语言生成关键词；多国家投放时只使用各投放国对应语言。只返回严格的 JSON 字符串，不要任何解释。";

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
              const raw = item.trim();
              return {
                keyword:
                  targetPlatformSlug === "instagram"
                    ? normalizeInstagramSearchKeyword(raw)
                    : raw,
                bucket: "product",
                is_exploration: false,
                reason: "",
              };
            }
            if (!item || typeof item !== "object") return null;
            const keyword = String(item.keyword || "").trim();
            if (!keyword) return null;
            const normalizedKeyword =
              targetPlatformSlug === "instagram"
                ? normalizeInstagramSearchKeyword(keyword)
                : keyword;
            return {
              keyword: normalizedKeyword,
              bucket: String(item.bucket || "product").trim(),
              is_exploration: Boolean(item.is_exploration),
              reason: String(item.reason || "").trim(),
            };
          })
          .filter(Boolean)
      : [];
    const selectedSignals = parseSelectedSignalKeywords(parsed, activeSignals);
    const droppedSignals = parseDroppedSignalKeywords(parsed);
    if (activeSignals.length > 0) {
      console.log(
        `[generateSearchKeywords] 候选 signal: ${activeSignals.length}, LLM 采用: ${selectedSignals.length}, LLM 丢弃: ${droppedSignals.length}`
      );
      if (droppedSignals.length > 0) {
        console.log(
          `[generateSearchKeywords] LLM 丢弃 signal: ` +
            droppedSignals
              .slice(0, 12)
              .map((s) => `${s.keyword}:${s.reason}`)
              .join(", ")
        );
      }
    }

    const withStrictSignals = enforceStrictKeywordSignals(
      normalizedItems,
      selectedSignals,
      targetPlatformSlug
    ).slice(0, effectiveMainGenerateCount);
    const searchQueries = withStrictSignals.map((x) => x.keyword);

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
      search_query_items: withStrictSignals,
      targetPlatform: targetPlatformSlug,
      keyword_signal_audit: {
        hard_filtered: signalFilter.dropped,
        selected: selectedSignals,
        llm_dropped: droppedSignals,
      },
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

export { enforceStrictKeywordSignals, buildKeywordSignalsSection };
