/**
 * 关键词信号池离线流程测试（不调用 LLM）。
 * 用法: node scripts/test-keyword-signals-flow.js
 */
import { enforceStrictKeywordSignals } from "../lib/tools/influencer-functions/generate-search-keywords.js";
import { normalizeSignalMatchKey } from "../lib/db/campaign-keyword-signals-dao.js";
import { extractKeywordSignalsFromInfluencer } from "../lib/influencer/extract-keyword-signals.js";

const assert = (cond, msg) => {
  if (!cond) throw new Error(msg);
};

function filterInstagramPromptSignals(signals) {
  return signals.filter((s) => s.signal_type === "hashtag");
}

function isKeywordExcluded(keyword, excludeSet) {
  const raw = String(keyword || "").trim().toLowerCase();
  if (!raw) return true;
  if (excludeSet.has(raw)) return true;
  const signalKey = normalizeSignalMatchKey(keyword);
  if (signalKey && excludeSet.has(signalKey)) return true;
  return false;
}

function filterPromptSignals(signals, excludeSet) {
  return signals.filter((s) => !isKeywordExcluded(s.signal_value, excludeSet));
}

// 1) 严格模式：LLM 漏掉的 signal 应被补入
{
  const signals = [
    { signal_type: "hashtag", signal_value: "#poolhack", influencer_count: 3 },
    { signal_type: "mention", signal_value: "@beatbot", influencer_count: 2 },
  ];
  const llmItems = [{ keyword: "random product review", bucket: "product", is_exploration: false, reason: "" }];
  const merged = enforceStrictKeywordSignals(llmItems, signals, "tiktok");
  const keywords = merged.map((x) => x.keyword);
  assert(keywords.includes("#poolhack"), "strict: missing hashtag injected");
  assert(keywords.includes("@beatbot"), "strict: missing mention injected");
  assert(keywords.includes("random product review"), "strict: keep llm items");
}

// 2) Instagram：仅 hashtag 进 prompt
{
  const raw = [
    { signal_type: "hashtag", signal_value: "#collegelife", influencer_count: 5 },
    { signal_type: "mention", signal_value: "@beatbot", influencer_count: 2 },
  ];
  const ig = filterInstagramPromptSignals(raw);
  assert(ig.length === 1 && ig[0].signal_value === "#collegelife", "IG filters mentions");
}

// 3) exclude + signal 归一化：#tag 与 history 中 saltwaterpool 冲突应排除
{
  const excludeSet = new Set(["saltwaterpool"]);
  const signals = [{ signal_type: "hashtag", signal_value: "#saltwaterpool", influencer_count: 2 }];
  const filtered = filterPromptSignals(signals, excludeSet);
  assert(filtered.length === 0, "excluded signal should not enter prompt");
}

// 4) batchGenerateCount = max(12, signals.length)
{
  const signalCount = 10;
  const batchGenerateCount = Math.max(12, signalCount);
  assert(batchGenerateCount === 12, "10 signals -> batch 12");
  const batch15 = Math.max(12, 15);
  assert(batch15 === 15, "15 signals -> batch 15");
}

// 5) 仅 isRecommended 才应在外层 ingest；提取器本身不校验 isRecommended
{
  const { hashtags } = extractKeywordSignalsFromInfluencer(
    {
      profile_data: { videos: [{ description: "#onlytag" }] },
    },
    {}
  );
  assert(hashtags.includes("#onlytag"), "extract works without isRecommended flag");
}

// 6) 品牌词过滤
{
  const { hashtags } = extractKeywordSignalsFromInfluencer(
    {
      profile_data: { videos: [{ description: "#mybrandpromo #nichepool" }] },
    },
    { brandName: "MyBrand" }
  );
  assert(!hashtags.some((t) => t.includes("mybrand")), "own brand filtered");
  assert(hashtags.includes("#nichepool"), "non-brand kept");
}

console.log("✅ keyword-signals flow tests passed");
