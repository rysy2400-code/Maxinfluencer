/**
 * 平台费拆分单元测试（无 DB）
 * node scripts/test-platform-fee.mjs
 */
import {
  calcPlatformFee,
  splitChargeAmounts,
  PLATFORM_FEE_RATE_PLATFORM,
  PLATFORM_FEE_RATE_USER,
  resolvePlatformFeeRate,
} from "../lib/billing/platform-fee.js";
import { INFLUENCER_SOURCE_USER } from "../lib/influencer/influencer-source.js";

function assert(cond, msg) {
  if (!cond) {
    console.error("FAIL:", msg);
    process.exit(1);
  }
}

assert(PLATFORM_FEE_RATE_PLATFORM === 0.05, "platform rate is 5%");
assert(PLATFORM_FEE_RATE_USER === 0.01, "user rate is 1%");
assert(resolvePlatformFeeRate(INFLUENCER_SOURCE_USER) === 0.01, "user source -> 1%");
assert(resolvePlatformFeeRate("web_search") === 0.05, "platform source -> 5%");
assert(calcPlatformFee(100) === 5, "default fee on 100 is 5%");
assert(calcPlatformFee(100, INFLUENCER_SOURCE_USER) === 1, "user fee on 100");
assert(calcPlatformFee(0) === 0, "fee on 0");
assert(calcPlatformFee(null) === 0, "fee on null");

const split = splitChargeAmounts(100);
assert(split.influencerAmount === 100, "influencer 100");
assert(split.platformFeeAmount === 5, "platform 5");
assert(split.platformFeeRate === 0.05, "platform rate snapshot");
assert(split.totalDeduct === 105, "total 105");

const splitUser = splitChargeAmounts(100, INFLUENCER_SOURCE_USER);
assert(splitUser.platformFeeAmount === 1, "user platform 1");
assert(splitUser.totalDeduct === 101, "user total 101");

const split2 = splitChargeAmounts(33.33);
assert(split2.platformFeeAmount === 1.67, "round platform fee");

console.log("✅ test-platform-fee.mjs passed");
