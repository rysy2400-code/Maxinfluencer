/**
 * 红人级「最新交付结果」单元测试（无 DB 依赖）
 * 运行：node scripts/test-deliverables-resolution.mjs
 */
import {
  normalizeDeliverables,
  resolveLatestDeliverables,
  formatDeliverablesSummary,
  renderDeliverablesClauseEn,
} from "../lib/execution/deliverables-resolution.js";
import { resolveLatestInfluencerQuote } from "../lib/execution/quote-resolution.js";

let passed = 0;
let failed = 0;

function assert(cond, msg) {
  if (cond) {
    passed += 1;
    return;
  }
  failed += 1;
  console.error("FAIL:", msg);
}

// 1. 归一化：平台规范名 + 数值项
const normalized = normalizeDeliverables({
  platforms: ["tiktok", "instagram", "YouTube", "Facebook"],
  videoCount: 1,
  bioLinkDays: 7,
  adCodeDays: 30,
  usageRightsDays: 90,
  note: "1 条视频全平台分发",
});
assert(normalized.platforms.length === 4, "应解析出 4 个平台");
assert(
  normalized.platforms.includes("TikTok") &&
    normalized.platforms.includes("Facebook"),
  "平台应规范化为 TikTok / Facebook"
);
assert(normalized.videoCount === 1, "videoCount=1");
assert(normalized.usageRightsDays === 90, "usageRightsDays=90");

// 2. 空值 / 纯空字符串 → null
assert(normalizeDeliverables(null) === null, "null 应返回 null");
assert(normalizeDeliverables({}) === null, "空对象应返回 null");
assert(normalizeDeliverables("   ") === null, "空字符串应返回 null");

// 3. 最近一条带 deliverables 的记录优先
const quoteNegotiation = [
  {
    role: "influencer",
    amount: 1230,
    currency: "USD",
    at: "2026-08-25T17:57:21.000Z",
  },
  {
    role: "influencer",
    amount: 1230,
    currency: "USD",
    at: "2026-08-26T03:24:41.000Z",
    deliverables: {
      platforms: ["TikTok", "Instagram", "YouTube", "Facebook"],
      videoCount: 1,
      bioLinkDays: 7,
      adCodeDays: 30,
      usageRightsDays: 90,
      source: "influencer_email",
    },
  },
  {
    role: "advertiser",
    amount: 1200,
    currency: "USD",
    at: "2026-08-26T04:00:00.000Z",
  },
];
const latest = resolveLatestDeliverables({ quoteNegotiation });
assert(latest != null, "应解析出最新交付结果");
assert(latest.platforms.length === 4, "最新交付结果应包含 4 个平台");
assert(
  latest.confirmedAt === "2026-08-26T03:24:41.000Z",
  "confirmedAt 应回填记录时间"
);

// 4. 只有 deliverables、没有金额的记录同样生效，且不影响「最新报价」
const withDeliverablesOnly = [
  ...quoteNegotiation,
  {
    role: "influencer",
    at: "2026-08-26T05:00:00.000Z",
    deliverables: { platforms: ["Instagram", "YouTube"] },
  },
];
const latestAfter = resolveLatestDeliverables({
  quoteNegotiation: withDeliverablesOnly,
});
assert(
  latestAfter.platforms.length === 2 &&
    latestAfter.platforms.includes("Instagram"),
  "无金额的交付结果记录应生效"
);
const quoteAfter = resolveLatestInfluencerQuote({
  quoteNegotiation: withDeliverablesOnly,
});
assert(
  quoteAfter.amount === 1230,
  "只有 deliverables 的记录不得改变最新报价"
);

// 5. 合同条款正文：平台与条目齐全、可确定性生成
const clause = renderDeliverablesClauseEn(latest, { productName: "Tripo" });
for (const platform of ["TikTok", "Instagram", "YouTube", "Facebook"]) {
  assert(clause.includes(platform), `合同条款应包含平台 ${platform}`);
}
assert(clause.includes("7 days"), "合同条款应包含 bio link 7 天");
assert(clause.includes("30 days"), "合同条款应包含 ad-code 30 天");
assert(clause.includes("90 days"), "合同条款应包含素材授权 90 天");
assert(
  !clause.includes("one TikTok video") || clause.includes("Instagram"),
  "不得退化成单一 TikTok 平台"
);

// 6. 中文摘要
const summary = formatDeliverablesSummary(latest);
assert(summary.includes("4 平台"), "摘要应显示平台数");
assert(summary.includes("bio link 7 天"), "摘要应显示 bio link 天数");
assert(summary.includes("素材授权 90 天"), "摘要应显示素材授权天数");

console.log(`\n通过 ${passed} 项，失败 ${failed} 项`);
if (failed > 0) process.exit(1);
