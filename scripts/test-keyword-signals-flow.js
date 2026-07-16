/**
 * 关键词信号池离线流程测试（不调用 LLM）。
 * 用法: node scripts/test-keyword-signals-flow.js
 */
import { enforceStrictKeywordSignals } from "../lib/tools/influencer-functions/generate-search-keywords.js";
import { normalizeSignalMatchKey } from "../lib/db/campaign-keyword-signals-dao.js";
import {
  extractKeywordSignalsFromInfluencer,
  filterKeywordSignalsForSearch,
} from "../lib/influencer/extract-keyword-signals.js";

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

// 1) 候选模式：只有 LLM 选择采用的 signal 才应被兜底补入
{
  const signals = [
    { signal_type: "hashtag", signal_value: "#poolhack", influencer_count: 3 },
  ];
  const llmItems = [{ keyword: "random product review", bucket: "product", is_exploration: false, reason: "" }];
  const merged = enforceStrictKeywordSignals(llmItems, signals, "tiktok");
  const keywords = merged.map((x) => x.keyword);
  assert(keywords.includes("#poolhack"), "selected signal injected");
  assert(keywords.includes("random product review"), "keep llm items");

  const notSelected = enforceStrictKeywordSignals(llmItems, [], "tiktok");
  assert(
    !notSelected.map((x) => x.keyword).includes("#poolhack"),
    "unselected signal should not be injected"
  );
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

// 7) 信号提取只读 profile_data.videos，不再从兼容字段/顶层 videos 取数
{
  const { hashtags } = extractKeywordSignalsFromInfluencer(
    {
      profile_data: {
        videos: [{ description: "#fromprofilevideos" }],
        videoList: [{ description: "#fromvideolist" }],
        posts: [{ description: "#fromposts" }],
        reels: [{ description: "#fromreels" }],
      },
      videos: [{ description: "#fromtopvideos" }],
    },
    {}
  );
  assert(hashtags.includes("#fromprofilevideos"), "profile_data.videos is read");
  assert(!hashtags.includes("#fromvideolist"), "profile_data.videoList ignored");
  assert(!hashtags.includes("#fromposts"), "profile_data.posts ignored");
  assert(!hashtags.includes("#fromreels"), "profile_data.reels ignored");
  assert(!hashtags.includes("#fromtopvideos"), "top-level videos ignored");
}

// 8) 确定性 signal 过滤：纯数字/过短/通用噪声应被拦截，有意义短 tag 保留
{
  const { kept, dropped } = filterKeywordSignalsForSearch([
    { signal_type: "hashtag", signal_value: "#85", influencer_count: 1 },
    { signal_type: "hashtag", signal_value: "#x", influencer_count: 1 },
    { signal_type: "hashtag", signal_value: "#howto", influencer_count: 1 },
    { signal_type: "hashtag", signal_value: "#ai", influencer_count: 1 },
    { signal_type: "hashtag", signal_value: "#designagent", influencer_count: 1 },
  ]);
  const keptValues = kept.map((s) => s.signal_value);
  const droppedReasons = dropped.map((s) => s.filter_reason);
  assert(!keptValues.includes("#85"), "numeric hashtag filtered");
  assert(!keptValues.includes("#x"), "too short hashtag filtered");
  assert(!keptValues.includes("#howto"), "generic noise hashtag filtered");
  assert(keptValues.includes("#ai"), "allowed short hashtag kept");
  assert(keptValues.includes("#designagent"), "specific hashtag kept");
  assert(droppedReasons.includes("numeric_hashtag"), "numeric reason recorded");
  assert(droppedReasons.includes("too_short_hashtag"), "short reason recorded");
  assert(droppedReasons.includes("generic_noise_hashtag"), "noise reason recorded");
}

console.log("✅ keyword-signals flow tests passed");
