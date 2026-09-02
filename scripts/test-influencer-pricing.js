#!/usr/bin/env node
/**
 * 单位红人报价策略单元测试
 * 运行: node scripts/test-influencer-pricing.js
 */

import {
  PRICING_MODE_ASK_CREATOR_QUOTE,
  PRICING_MODE_COMMISSION_ONLY,
  PRICING_MODE_ECPM_WITH_CAP,
  computeQuotedFlatFeeUsd,
  getDefaultInfluencerPricing,
  formatInfluencerPricingLabel,
  isCampaignInfoComplete,
  mergeInfluencerPricingExtracted,
  normalizeInfluencerPricing,
  validateInfluencerPricing,
} from "../lib/campaign/influencer-pricing.js";

let passed = 0;
let failed = 0;

function assert(cond, msg) {
  if (cond) {
    passed += 1;
    console.log(`  ✓ ${msg}`);
  } else {
    failed += 1;
    console.error(`  ✗ ${msg}`);
  }
}

console.log("influencer-pricing 单元测试\n");

console.log("默认策略");
const def = getDefaultInfluencerPricing();
assert(def.mode === PRICING_MODE_ASK_CREATOR_QUOTE, "默认 mode=ask_creator_quote");
assert(def.ecpmUsd === null, "默认 ecpmUsd=null");
assert(def.maxFlatFeeUsd === null, "默认 maxFlatFeeUsd=null");

console.log("\ncomputeQuotedFlatFeeUsd");
assert(
  computeQuotedFlatFeeUsd(10000, def) === null,
  "ask_creator_quote 默认 → 不生成系统报价"
);
assert(
  computeQuotedFlatFeeUsd(
    10000,
    { mode: PRICING_MODE_ECPM_WITH_CAP, ecpmUsd: 3, maxFlatFeeUsd: 1000 }
  ) === 30,
  "ecpm=3 时 1万播放 → $30"
);
assert(
  computeQuotedFlatFeeUsd(
    500000,
    { mode: PRICING_MODE_ECPM_WITH_CAP, ecpmUsd: 3, maxFlatFeeUsd: 1000 }
  ) === 1000,
  "50万播放 cap → $1000"
);
assert(
  computeQuotedFlatFeeUsd(500000, { mode: PRICING_MODE_ECPM_WITH_CAP, ecpmUsd: 5, maxFlatFeeUsd: 500 }) === 500,
  "自定义 ecpm=5 cap=500 → $500"
);
assert(
  computeQuotedFlatFeeUsd(10000, { mode: PRICING_MODE_COMMISSION_ONLY }) === null,
  "commission_only → null"
);
assert(computeQuotedFlatFeeUsd(null, def) === null, "无播放量 → null");

console.log("\nvalidateInfluencerPricing");
assert(
  validateInfluencerPricing({ mode: PRICING_MODE_ASK_CREATOR_QUOTE }, 0).isValid,
  "ask_creator_quote + 0% 佣金有效"
);
assert(
  validateInfluencerPricing({ mode: PRICING_MODE_COMMISSION_ONLY }, 15).isValid,
  "commission_only + 15% 有效"
);
assert(
  validateInfluencerPricing({ mode: PRICING_MODE_COMMISSION_ONLY }, 0).isValid,
  "commission_only + 0% 有效（纯产品置换）"
);
assert(
  validateInfluencerPricing(def, 0).isValid,
  "ecpm_with_cap + 0% 佣金有效"
);
assert(
  formatInfluencerPricingLabel(
    { mode: PRICING_MODE_COMMISSION_ONLY },
    0
  ).includes("纯产品置换"),
  "0% commission_only 显示为纯产品置换"
);
assert(
  formatInfluencerPricingLabel({ mode: PRICING_MODE_ASK_CREATOR_QUOTE }, 0) ===
    "不主动报价，询问红人合作价格",
  "ask_creator_quote 显示为「不主动报价，询问红人合作价格」"
);

console.log("\nnormalizeInfluencerPricing（别名归一化）");
const normZh = normalizeInfluencerPricing({ mode: "不主动报价，询问红人合作价格" });
assert(
  normZh.mode === PRICING_MODE_ASK_CREATOR_QUOTE && normZh.ecpmUsd === null,
  "中文别名归一化为 ask_creator_quote 且 eCPM 置空"
);
const normEn = normalizeInfluencerPricing({ mode: "ask creator quote" });
assert(
  normEn.mode === PRICING_MODE_ASK_CREATOR_QUOTE,
  "英文带空格写法归一化为 ask_creator_quote"
);

console.log("\nisCampaignInfoComplete");
assert(
  isCampaignInfoComplete({
    platform: "TikTok",
    region: "美国",
    publishTimeRange: "2024-03",
    budget: 10000,
    commission: 0,
  }),
  "完整 campaign（含默认 ask_creator_quote + 0% 佣金）"
);
assert(
  isCampaignInfoComplete({
    platform: "TikTok",
    region: "美国",
    publishTimeRange: "2024-03",
    budget: 10000,
    commission: 0,
    influencerPricing: { mode: PRICING_MODE_COMMISSION_ONLY },
  }),
  "0% + commission_only 完整（纯产品置换）"
);

console.log("\nmergeInfluencerPricingExtracted");
const merged = mergeInfluencerPricingExtracted(
  { mode: "commission_only" },
  { influencerPricing: getDefaultInfluencerPricing() }
);
assert(merged.mode === PRICING_MODE_COMMISSION_ONLY, "提取 commission_only 覆盖默认");
const mergedAsk = mergeInfluencerPricingExtracted(
  { mode: "ask_creator_quote", ecpmUsd: 3, maxFlatFeeUsd: 1000 },
  { influencerPricing: { mode: PRICING_MODE_ECPM_WITH_CAP, ecpmUsd: 5, maxFlatFeeUsd: 500 } }
);
assert(
  mergedAsk.mode === PRICING_MODE_ASK_CREATOR_QUOTE && mergedAsk.ecpmUsd === null,
  "提取 ask_creator_quote 时 eCPM/上限被置空"
);

console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
process.exit(failed > 0 ? 1 : 0);
