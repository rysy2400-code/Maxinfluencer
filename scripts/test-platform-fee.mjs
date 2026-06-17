/**
 * 平台费拆分单元测试（无 DB）
 * node scripts/test-platform-fee.mjs
 */
import { calcPlatformFee, splitChargeAmounts, PLATFORM_FEE_RATE } from "../lib/billing/platform-fee.js";

function assert(cond, msg) {
  if (!cond) {
    console.error("FAIL:", msg);
    process.exit(1);
  }
}

assert(PLATFORM_FEE_RATE === 0.05, "rate is 5%");
assert(calcPlatformFee(100) === 5, "fee on 100");
assert(calcPlatformFee(0) === 0, "fee on 0");
assert(calcPlatformFee(null) === 0, "fee on null");

const split = splitChargeAmounts(100);
assert(split.influencerAmount === 100, "influencer 100");
assert(split.platformFeeAmount === 5, "platform 5");
assert(split.totalDeduct === 105, "total 105");

const split2 = splitChargeAmounts(33.33);
assert(split2.platformFeeAmount === 1.67, "round platform fee");

console.log("✅ test-platform-fee.mjs passed");
