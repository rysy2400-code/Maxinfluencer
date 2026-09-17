/**
 * 回填某位红人在某个 Campaign 下的「最新交付结果」。
 *
 * 背景：交付结果与最新报价同源，存在 tiktok_campaign_execution.quote_negotiation
 * 条目的 deliverables 字段上（与红人沟通的最终交付范围）。历史数据没有该字段时，
 * 合同只能回落到 Campaign 默认交付结果 + 红人主平台，可能写错平台/条数。
 *
 * 默认 dry-run，传 --apply 才写库（不修改 flat_fee / stage）。
 *
 *   node scripts/backfill-execution-deliverables.mjs \
 *     --campaign CAMP-xxx --handle engineering_addiction \
 *     --platforms tiktok,instagram,youtube,facebook \
 *     --video-count 1 --bio-link-days 7 --ad-code-days 30 --usage-days 90 \
 *     --note "1 条视频全平台分发"
 *
 *   # 确认无误后写库（末尾追加 --apply）
 */
import { getExecutionRow, updateExecutionStage } from "../lib/db/campaign-dao.js";
import {
  formatDeliverablesSummary,
  normalizeDeliverables,
} from "../lib/execution/deliverables-resolution.js";

function readArg(name) {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx === -1) return null;
  const value = process.argv[idx + 1];
  return value && !value.startsWith("--") ? value : "";
}

const apply = process.argv.includes("--apply");
const campaignId = String(readArg("campaign") || "").trim();
const handle = String(readArg("handle") || "").replace(/^@/, "").trim();

if (!campaignId || !handle) {
  console.error(
    "用法：node scripts/backfill-execution-deliverables.mjs --campaign CAMP-xxx --handle <handle> --platforms a,b --video-count 1 [--bio-link-days 7] [--ad-code-days 30] [--usage-days 90] [--note \"...\"] [--apply]"
  );
  process.exit(1);
}

const deliverables = normalizeDeliverables({
  platforms: readArg("platforms") || null,
  videoCount: readArg("video-count"),
  bioLinkDays: readArg("bio-link-days"),
  adCodeDays: readArg("ad-code-days"),
  usageRightsDays: readArg("usage-days"),
  note: readArg("note") || null,
});

if (!deliverables) {
  console.error("没有可写入的交付结果：请至少提供 --platforms / --video-count / 各时效天数之一");
  process.exit(1);
}

const row = await getExecutionRow(campaignId, handle);
if (!row) {
  console.error(`未找到执行行：campaign=${campaignId} handle=${handle}`);
  process.exit(1);
}

const entry = {
  role: "influencer",
  currency: row.currency || "USD",
  at: new Date().toISOString(),
  source: "manual_deliverables_backfill",
  deliverables,
};

console.log("[backfill-execution-deliverables] 目标执行行：");
console.log(
  JSON.stringify(
    {
      campaignId,
      handle: row.tiktok_username || handle,
      influencerId: row.influencer_id || null,
      stage: row.stage,
      flatFee: row.flat_fee,
      currency: row.currency,
    },
    null,
    2
  )
);
console.log("\n将追加到 quote_negotiation 的记录（不改 flat_fee / stage）：");
console.log(JSON.stringify(entry, null, 2));
console.log(`\n卡片/合同展示：${formatDeliverablesSummary(deliverables)}`);

if (!apply) {
  console.log("\n[dry-run] 未写库；确认无误后追加 --apply 重新执行。");
  process.exit(0);
}

const updated = await updateExecutionStage(campaignId, handle, {
  quoteAppend: {
    ...entry,
    updateFlatFee: false,
  },
});
console.log(
  updated
    ? "\n[applied] 已写入 quote_negotiation（flat_fee / stage 未改动）。"
    : "\n[applied] 未写入：执行行不存在。"
);
process.exit(updated ? 0 : 1);
