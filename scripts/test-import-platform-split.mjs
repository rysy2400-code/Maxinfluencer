/**
 * 平台拆分 + 批次汇总纯函数测试（不写库）。
 */
import {
  splitImportRowsByPlatform,
  platformSubtaskBatchId,
  platformLabel,
} from "../lib/influencer/import-platform-split.js";
import { buildImportBatchSummary } from "../lib/influencer/import-batch-coordinator.js";

function assert(cond, message) {
  if (!cond) {
    console.error(`[FAIL] ${message}`);
    process.exitCode = 1;
  } else {
    console.log(`[PASS] ${message}`);
  }
}

const rows = [
  { username: "yt1", platform: "YouTube", platformSlug: "youtube" },
  { username: "yt2", platform: "YouTube", platformSlug: "youtube" },
  { username: "tt1", platform: "TikTok", platformSlug: "tiktok" },
  { username: "ig1", platform: "Instagram", platformSlug: "instagram" },
  { username: "x1", platform: "X", platformSlug: "x" },
  { username: "unknown1", platform: "Other", platformSlug: null },
];

const buckets = splitImportRowsByPlatform(rows);
assert(buckets.youtube.length === 2, "youtube 桶 2 行");
assert(buckets.tiktok.length === 1, "tiktok 桶 1 行");
assert(buckets.instagram.length === 1, "instagram 桶 1 行");
assert(buckets.x.length === 1, "x 桶 1 行");
assert(buckets.unknown.length === 1, "unknown 桶 1 行");
assert(
  platformSubtaskBatchId("IMP-1", "youtube") !== platformSubtaskBatchId("IMP-1", "tiktok"),
  "同批次不同平台 import_batch_id 不冲突"
);
assert(platformLabel("youtube") === "YouTube", "平台标签 YouTube");

const summary = buildImportBatchSummary([
  {
    platform: "youtube",
    contact_mode: "contact_all",
    status: "succeeded",
    total_rows: 3,
    progress_analyzed_count: 3,
    progress_recommended_count: 2,
    result_summary: "已分析：3 位\n推荐：2 位\n将联系：2 位（符合投放地区且有邮箱，已置为待联系，按每天节奏联系）",
  },
  {
    platform: "tiktok",
    status: "failed",
    total_rows: 1,
    progress_analyzed_count: 0,
    progress_recommended_count: 0,
    error_message: "browserType.connectOverCDP: Timeout 20000ms exceeded.",
  },
]);
console.log(summary);
assert(summary.includes("【名单导入完成】"), "汇总含标题");
assert(summary.includes("YouTube（3 位）：已分析 3 · 推荐 2 · 将联系 2"), "汇总含 YouTube 明细");
assert(summary.includes("（直接联系模式：符合 campaign 投放地区且有邮箱的红人一律联系）"), "contact_all 模式标注");
assert(summary.includes("TikTok（1 位）：失败"), "汇总含 TikTok 失败");
assert(summary.includes("connectOverCDP"), "汇总含失败原因");

const allOk = buildImportBatchSummary([
  {
    platform: "instagram",
    status: "succeeded",
    total_rows: 1,
    progress_analyzed_count: 1,
    progress_recommended_count: 1,
    result_summary: "已分析：1 位\n推荐：1 位\n已联系：1 位",
  },
]);
assert(allOk.includes("Instagram（1 位）：已分析 1 · 推荐 1 · 将联系 1"), "全成功汇总格式");

// 「仅排重/不联系」批次：不生成通用汇总（生效确认已由导入工具同步返回）
const dncOnly = buildImportBatchSummary([
  {
    platform: "mixed",
    contact_mode: "do_not_contact",
    status: "succeeded",
    total_rows: 668,
    progress_analyzed_count: 0,
    progress_recommended_count: 0,
    result_summary: "不联系名单已生效（本 campaign）。\n- 识别并去重: 668 位",
  },
]);
assert(dncOnly === "", "纯不联系批次不生成通用汇总");

// 混合批次（含普通导入）：仍正常汇总
const mixedMode = buildImportBatchSummary([
  {
    platform: "youtube",
    contact_mode: "do_not_contact",
    status: "succeeded",
    total_rows: 10,
  },
  {
    platform: "tiktok",
    contact_mode: "recommended_only",
    status: "succeeded",
    total_rows: 2,
    progress_analyzed_count: 2,
    progress_recommended_count: 1,
    result_summary: "已分析：2 位\n推荐：1 位\n已联系：0 位",
  },
]);
assert(mixedMode.includes("YouTube（10 位）"), "混合批次含不联系平台明细");
assert(mixedMode.includes("TikTok（2 位）：已分析 2 · 推荐 1 · 将联系 0"), "混合批次含普通导入明细");

if (process.exitCode) {
  console.error("[test] 存在失败断言");
  process.exit(1);
}
console.log("[test] ✅ 全部通过");
