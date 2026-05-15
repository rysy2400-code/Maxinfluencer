/**
 * 验证单红人 enrich 预算：env 解析 +（可选）headless 下超时是否触发。
 *
 * 用法：
 *   node scripts/verify-enrich-per-influencer-timeout.mjs
 *   PLAYWRIGHT_HEADLESS=true node scripts/verify-enrich-per-influencer-timeout.mjs
 *
 * 说明：代码中低于 10000ms 的 env 会被视为非法并回退默认 120000ms，故集成用例使用 ≥10000 的预算。
 */
import assert from "node:assert/strict";

import {
  enrichInfluencerProfiles,
  resolveEnrichPerInfluencerBudgetMs,
} from "../lib/tools/influencer-functions/search-and-extract-influencers.js";

function testResolve() {
  const prev = process.env.ENRICH_PROFILE_PER_INFLUENCER_TIMEOUT_MS;
  try {
    delete process.env.ENRICH_PROFILE_PER_INFLUENCER_TIMEOUT_MS;
    assert.equal(resolveEnrichPerInfluencerBudgetMs(), 120000);

    process.env.ENRICH_PROFILE_PER_INFLUENCER_TIMEOUT_MS = "90000";
    assert.equal(resolveEnrichPerInfluencerBudgetMs(), 90000);

    process.env.ENRICH_PROFILE_PER_INFLUENCER_TIMEOUT_MS = "5000";
    assert.equal(resolveEnrichPerInfluencerBudgetMs(), 120000);

    process.env.ENRICH_PROFILE_PER_INFLUENCER_TIMEOUT_MS = "abc";
    assert.equal(resolveEnrichPerInfluencerBudgetMs(), 120000);

    process.env.ENRICH_PROFILE_PER_INFLUENCER_TIMEOUT_MS = "2000000";
    assert.equal(resolveEnrichPerInfluencerBudgetMs(), 2000000);
  } finally {
    if (prev === undefined) delete process.env.ENRICH_PROFILE_PER_INFLUENCER_TIMEOUT_MS;
    else process.env.ENRICH_PROFILE_PER_INFLUENCER_TIMEOUT_MS = prev;
  }
  console.log("✓ resolveEnrichPerInfluencerBudgetMs() 行为符合预期");
}

async function testHeadlessTimeout() {
  if (process.env.PLAYWRIGHT_HEADLESS !== "true") {
    console.log("⊘ 跳过 headless 集成：设置 PLAYWRIGHT_HEADLESS=true 可跑 Chromium 路径");
    return;
  }
  const prevBudget = process.env.ENRICH_PROFILE_PER_INFLUENCER_TIMEOUT_MS;
  /** 慢于预算的首跳 goto；预算须 ≥10000 否则 resolve 会回退到 120000 */
  const budgetMs = 12_000;
  process.env.ENRICH_PROFILE_PER_INFLUENCER_TIMEOUT_MS = String(budgetMs);

  const record = {
    username: "slowbin",
    profileUrl: "https://httpbin.org/delay/15",
    displayName: "slow",
    avatarUrl: "",
    followers: { count: 0, display: "0" },
    bio: "",
    verified: false,
  };

  const t0 = Date.now();
  const out = await enrichInfluencerProfiles([record], {
    maxCount: 1,
    concurrency: 1,
    enableLiveMatch: false,
    campaignId: null,
    taskId: null,
    delayBetweenBatches: { min: 0, max: 0 },
  });
  const elapsed = Date.now() - t0;

  assert.ok(Array.isArray(out) && out.length === 1, "应返回 1 条记录");
  const first = out[0];
  assert.ok(
    elapsed < 60_000,
    `应在合理时间内结束（实际 ${elapsed}ms），避免整段挂死`
  );

  assert.equal(first.username, "slowbin", "超时后应退回搜索阶段记录");
  assert.ok(
    elapsed >= budgetMs - 2500 && elapsed < budgetMs + 25_000,
    `预算 ${budgetMs}ms 时应在中途截断（实际 ${elapsed}ms），不应等满 httpbin 15s+后续步骤`
  );
  assert.ok(
    first.profile_data == null,
    "超时路径下 merge 失败形态不挂载 profile_data（与 mergeInfluencerData 一致）"
  );
  console.log(
    `✓ headless 单红人总预算生效：${elapsed}ms（预算 ${budgetMs}ms，慢 goto 被 race 截断）`
  );

  if (prevBudget === undefined) delete process.env.ENRICH_PROFILE_PER_INFLUENCER_TIMEOUT_MS;
  else process.env.ENRICH_PROFILE_PER_INFLUENCER_TIMEOUT_MS = prevBudget;
}

async function main() {
  testResolve();
  await testHeadlessTimeout();
  console.log("\nverify-enrich-per-influencer-timeout: 全部检查完成");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
