/**
 * 扣款规则单元校验（无 DB）
 * node scripts/test-approve-quote-charge-logic.mjs
 */
import assert from "node:assert/strict";
import {
  resolveQuoteApproveCharge,
} from "../lib/billing/approve-quote-charge.js";
import {
  formatInsufficientBalanceMessage,
  NON_USD_QUOTE_MESSAGE,
  INVALID_QUOTE_MESSAGE,
} from "../lib/billing/balance-messages.js";

const campaignEcpm = { campaignInfo: { influencerPricing: { mode: "ecpm_with_cap" } } };
const campaignCommission = {
  campaignInfo: { influencerPricing: { mode: "commission_only" } },
};

assert.equal(
  resolveQuoteApproveCharge(campaignEcpm, { flat_fee: 500, currency: "USD" }).chargeAmount,
  500
);

assert.equal(
  resolveQuoteApproveCharge(campaignCommission, { flat_fee: null, currency: "USD" }).chargeAmount,
  0
);

assert.equal(
  resolveQuoteApproveCharge(campaignCommission, { flat_fee: 0, currency: "USD" }).chargeAmount,
  0
);

assert.equal(
  resolveQuoteApproveCharge(campaignEcpm, { flat_fee: null, currency: "USD" }).message,
  INVALID_QUOTE_MESSAGE
);

assert.equal(
  resolveQuoteApproveCharge(campaignEcpm, { flat_fee: 100, currency: "EUR" }).message,
  NON_USD_QUOTE_MESSAGE
);

assert.match(
  formatInsufficientBalanceMessage(500, 120),
  /余额不足：需 \$500\.00，当前 \$120\.00/
);

console.log("✅ approve-quote-charge 规则校验通过");
