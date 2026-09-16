/**
 * 同意报价扣款逻辑（无 DB）
 * node scripts/test-approve-quote-charge-logic.mjs
 */
import {
  buildApprovedTermsSnapshot,
  resolveQuoteApproveCharge,
} from "../lib/billing/approve-quote-charge.js";
import { INFLUENCER_SOURCE_USER } from "../lib/influencer/influencer-source.js";

function assert(cond, msg) {
  if (!cond) {
    console.error("FAIL:", msg);
    process.exit(1);
  }
}

const campaign = { campaignInfo: { influencerPricing: { mode: "flat_fee" } } };

const platformRow = { flat_fee: 100, currency: "USD", source: "web_search" };
const platformCharge = resolveQuoteApproveCharge(campaign, platformRow);
assert(platformCharge.ok, "platform charge ok");
assert(platformCharge.platformFeeAmount === 5, "platform fee 5");
assert(platformCharge.chargeAmount === 105, "platform total 105");

const counterPendingRow = {
  flat_fee: 200,
  currency: "USD",
  source: "web_search",
  quote_negotiation: [
    { role: "influencer", amount: 1050, currency: "USD" },
    { role: "advertiser", type: "counter", amount: 200, currency: "USD" },
  ],
};
const pendingCounterCharge = resolveQuoteApproveCharge(campaign, counterPendingRow);
assert(pendingCounterCharge.influencerAmount === 1050, "pending advertiser counter does not change charge");

const userRow = { flat_fee: 100, currency: "USD", source: INFLUENCER_SOURCE_USER };
const userCharge = resolveQuoteApproveCharge(campaign, userRow);
assert(userCharge.ok, "user charge ok");
assert(userCharge.platformFeeAmount === 1, "user fee 1");
assert(userCharge.chargeAmount === 101, "user total 101");
assert(userCharge.influencerSource === INFLUENCER_SOURCE_USER, "source snapshot");

// 报价为 0（免费合作 / 产品置换）：非纯佣金模式下也允许同意，且不扣款
const zeroFeeRow = { flat_fee: 0, currency: "USD", source: "web_search" };
const zeroFeeCharge = resolveQuoteApproveCharge(campaign, zeroFeeRow);
assert(zeroFeeCharge.ok, "zero quote ok in non-commission mode");
assert(zeroFeeCharge.chargeAmount === 0, "zero quote charge 0");
assert(zeroFeeCharge.influencerAmount === 0, "zero quote influencer amount 0");
assert(zeroFeeCharge.platformFeeAmount === 0, "zero quote platform fee 0");

// 报价为空：非纯佣金模式仍拦截
const nullFeeRow = { flat_fee: null, currency: "USD", source: "web_search" };
const nullFeeCharge = resolveQuoteApproveCharge(campaign, nullFeeRow);
assert(!nullFeeCharge.ok, "null quote blocked in non-commission mode");

// 报价为空：只认「这条红人自己当初按纯佣金口径邀约」的执行行（不再看 campaign 当前模式）
const campaignNowAskQuote = { campaignInfo: { influencerPricing: { mode: "ask_creator_quote" } } };
const commissionOnlyInviteRow = {
  flat_fee: null,
  currency: "USD",
  source: "web_search",
  last_event: { outreachEmail: { pricingMode: "commission_only" } },
};
const nullFeeCommissionCharge = resolveQuoteApproveCharge(
  campaignNowAskQuote,
  commissionOnlyInviteRow
);
assert(nullFeeCommissionCharge.ok, "commission_only 邀约的行报价为空仍可同意");
assert(nullFeeCommissionCharge.chargeAmount === 0, "null quote commission charge 0");

// campaign 模式是 commission_only，但这条执行行是按 ask_creator_quote 邀约、且没给价 → 仍拦截
const commissionOnlyCampaign = {
  campaignInfo: { influencerPricing: { mode: "commission_only" } },
};
const askQuoteInviteRow = {
  flat_fee: null,
  currency: "USD",
  source: "web_search",
  last_event: { outreachEmail: { pricingMode: "ask_creator_quote" } },
};
assert(
  !resolveQuoteApproveCharge(commissionOnlyCampaign, askQuoteInviteRow).ok,
  "按询价口径邀约但未给价 → 拦截"
);

// 执行级条款 0 固定费 + 佣金：允许，且不扣款
const agreedTermsRow = {
  flat_fee: 0,
  commission_percent: 10,
  currency: "USD",
  source: "web_search",
  last_event: { outreachEmail: { pricingMode: "commission_only" } },
};
const agreedTermsCharge = resolveQuoteApproveCharge(campaignNowAskQuote, agreedTermsRow);
assert(agreedTermsCharge.ok, "0 固定费 + 10% 佣金可同意");
assert(agreedTermsCharge.chargeAmount === 0, "0 固定费不扣款");
assert(agreedTermsCharge.commissionPercent === 10, "回传佣金口径");

// 有固定费 + 佣金：佣金不影响扣款金额
const feePlusCommissionRow = {
  flat_fee: 1000,
  commission_percent: 10,
  currency: "USD",
  source: "web_search",
};
const feePlusCommissionCharge = resolveQuoteApproveCharge(
  campaignNowAskQuote,
  feePlusCommissionRow
);
assert(feePlusCommissionCharge.chargeAmount === 1050, "固定费 1000 → 扣 1050");
assert(feePlusCommissionCharge.commissionPercent === 10, "回传佣金口径（有固定费）");

// 回归：同意时写入 last_event.approvedTerms 的条款快照必须带币种
// （此前 approveQuoteWithCharge 直接引用只存在于 resolveQuoteApproveCharge 内的
//   currency 变量，导致点击「同意」抛 ReferenceError: currency is not defined）
const zeroFeeSnapshot = buildApprovedTermsSnapshot(agreedTermsCharge, 0);
assert(zeroFeeSnapshot.currency === "USD", "0 固定费快照币种为 USD");
assert(zeroFeeSnapshot.fixedFeeUsd === 0, "0 固定费快照固定费为 0");
assert(zeroFeeSnapshot.commissionPercent === 10, "0 固定费快照佣金 10%");
assert(zeroFeeSnapshot.chargedAmount === 0, "0 固定费快照扣款 0");

const feeSnapshot = buildApprovedTermsSnapshot(feePlusCommissionCharge, -1050);
assert(feeSnapshot.currency === "USD", "有固定费快照币种为 USD");
assert(feeSnapshot.fixedFeeUsd === 1000, "有固定费快照固定费 1000");
assert(feeSnapshot.chargedAmount === 1050, "扣款金额取绝对值");

const fallbackCurrencySnapshot = buildApprovedTermsSnapshot({ fixedFeeUsd: 0 }, 0);
assert(fallbackCurrencySnapshot.currency === "USD", "币种缺失时兜底 USD");

console.log("✅ test-approve-quote-charge-logic.mjs passed");
