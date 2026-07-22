/**
 * 同意报价扣款逻辑（无 DB）
 * node scripts/test-approve-quote-charge-logic.mjs
 */
import { resolveQuoteApproveCharge } from "../lib/billing/approve-quote-charge.js";
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

console.log("✅ test-approve-quote-charge-logic.mjs passed");
