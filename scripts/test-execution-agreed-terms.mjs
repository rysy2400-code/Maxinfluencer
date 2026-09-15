/**
 * 执行级条款（固定费 + 佣金）与合同费用条款（无 DB）
 * node scripts/test-execution-agreed-terms.mjs
 */
import {
  normalizeCommissionPercent,
  normalizeFixedFeeUsd,
  resolveExecutionAgreedTerms,
  validateQuoteSubmittedAdmission,
} from "../lib/execution/agreed-terms.js";
import { buildFeeClause } from "../lib/contract/contract-clauses.js";

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

// —— 归一化：0 是明确值，空字符串/非法值才算未谈定 ——
assert(normalizeFixedFeeUsd(0) === 0, "固定费 0 是明确值");
assert(normalizeFixedFeeUsd("") === null, "固定费空字符串 = 未谈定");
assert(normalizeFixedFeeUsd(null) === null, "固定费 null = 未谈定");
assert(normalizeFixedFeeUsd(1000) === 1000, "固定费 1000");
assert(normalizeCommissionPercent(0) === 0, "佣金 0 是明确值");
assert(normalizeCommissionPercent("") === null, "佣金空字符串 = 未谈定");
assert(normalizeCommissionPercent(10) === 10, "佣金 10");
assert(normalizeCommissionPercent(120) === null, "佣金超 100 非法");

// —— 条款解析 ——
const campaign = {
  campaignInfo: { commission: 10, influencerPricing: { mode: "ask_creator_quote" } },
};
const nothingAgreed = resolveExecutionAgreedTerms(campaign, {
  flat_fee: null,
  commission_percent: null,
  currency: "USD",
  last_event: { outreachEmail: { pricingMode: "ask_creator_quote" } },
});
assert(nothingAgreed.fixedFeeUsd === null, "未谈定：固定费 null");
assert(nothingAgreed.commissionPercent === 10, "未单独谈佣金 → 回落 campaign 佣金");
assert(nothingAgreed.isQuoteReady === false, "未谈定固定费 → 条款未齐");

const zeroTerms = resolveExecutionAgreedTerms(campaign, {
  flat_fee: 0,
  commission_percent: 10,
  currency: "USD",
  last_event: { outreachEmail: { pricingMode: "commission_only" } },
});
assert(zeroTerms.isQuoteReady === true, "0 固定费 + 10% 佣金 = 条款齐");
assert(zeroTerms.isCommissionOnlyInvite === true, "纯佣金邀约");

const commissionOnlyWithoutTerms = resolveExecutionAgreedTerms(
  { campaignInfo: { commission: 3 } },
  {
    flat_fee: null,
    currency: "USD",
    last_event: { outreachEmail: { pricingMode: "commission_only" } },
  }
);
assert(
  commissionOnlyWithoutTerms.isCommissionOnlyInvite === true,
  "存量数据：纯佣金邀约 + 无固定费视为无固定费成交"
);
assert(
  commissionOnlyWithoutTerms.fixedFeeUsd === 0 && commissionOnlyWithoutTerms.isQuoteReady === true,
  "纯佣金邀约：固定费天然为 0，红人接受邀约即为价格确定"
);
assert(
  resolveExecutionAgreedTerms(
    { campaignInfo: { commission: 3 } },
    {
      flat_fee: null,
      currency: "USD",
      last_event: { outreachEmail: { pricingMode: "ask_creator_quote" } },
    }
  ).isQuoteReady === false,
  "询价口径邀约：没给价就是价格未定"
);

// —— 硬准入 ——
assert(validateQuoteSubmittedAdmission(zeroTerms).ready === true, "条款齐 → 可进待审核");
assert(
  validateQuoteSubmittedAdmission({ fixedFeeUsd: null, commissionPercent: 10 }).ready === false,
  "缺固定费 → 不可进待审核"
);
assert(
  validateQuoteSubmittedAdmission({ fixedFeeUsd: 100, commissionPercent: null }).ready === false,
  "缺佣金 → 不可进待审核"
);

// —— 合同费用条款 ——
const feeOnly = buildFeeClause({ feeAmount: 1000, commissionPercent: null });
assert(feeOnly.includes("one-time flat fee of USD 1,000.00"), "有固定费条款");
assert(!feeOnly.includes("commission"), "无佣金不写佣金");

const feeAndCommission = buildFeeClause({ feeAmount: 1000, commissionPercent: 10 });
assert(feeAndCommission.includes("one-time flat fee of USD 1,000.00"), "固定费 + 佣金：含固定费");
assert(feeAndCommission.includes("commission of 10%"), "固定费 + 佣金：含佣金");

const commissionOnly = buildFeeClause({ feeAmount: 0, commissionPercent: 10 });
assert(commissionOnly.includes("commission-only"), "纯佣金条款");
assert(commissionOnly.includes("no fixed fee"), "纯佣金条款写明无固定费");
assert(!commissionOnly.includes("flat fee of USD 0.00"), "纯佣金不写 0 元固定费");

const productOnly = buildFeeClause({ feeAmount: 0, commissionPercent: 0 });
assert(productOnly.includes("product-only"), "纯产品置换条款");
assert(!productOnly.includes("flat fee of USD 0.00"), "纯置换不写 0 元固定费");

console.log(`结果: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
