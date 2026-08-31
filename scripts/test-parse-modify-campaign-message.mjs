#!/usr/bin/env node
import {
  parseModifyCampaignChangesFromUserMessage,
  parseMoneyNumberToken,
  parsePricingChangesFromUserMessage,
} from "../lib/campaign/parse-modify-campaign-message.js";

let ok = 0;
let fail = 0;
function assert(c, m) {
  if (c) {
    ok++;
    console.log("✓", m);
  } else {
    fail++;
    console.error("✗", m);
  }
}

const p1 = parsePricingChangesFromUserMessage("单位红人报价策略：无固定费用");
assert(p1?.pricingMode === "commission_only", "无固定费用 → commission_only");

const p2 = parseModifyCampaignChangesFromUserMessage("佣金：20%");
assert(p2?.commission === 20, "佣金 20%");

const p3 = parseModifyCampaignChangesFromUserMessage("总预算：50000");
assert(p3?.budget === 50000, "总预算 50000");

assert(parseMoneyNumberToken("1,000") === 1000, "parseMoneyNumberToken 1,000");
assert(parseMoneyNumberToken("15,450.50") === 15450.5, "parseMoneyNumberToken 15,450.50");

const p4 = parseModifyCampaignChangesFromUserMessage("总预算：$15,450");
assert(p4?.budget === 15450, "总预算 $15,450");

const p5 = parseModifyCampaignChangesFromUserMessage(
  "单位红人报价策略：按 eCPM=$1 给红人报价，最高不超过 $1,000"
);
assert(p5?.pricingEcpmUsd === 1, "eCPM=$1 解析为 1");
assert(p5?.pricingMaxFlatFeeUsd === 1000, "最高不超过 $1,000 解析为 1000");
assert(p5?.pricingMode === "ecpm_with_cap", "eCPM+上限 → ecpm_with_cap");

const p6 = parsePricingChangesFromUserMessage("报价策略：ecpm 5，上限 2,500");
assert(p6?.pricingEcpmUsd === 5, "ecpm 5");
assert(p6?.pricingMaxFlatFeeUsd === 2500, "上限 2,500");

const p7 = parseModifyCampaignChangesFromUserMessage(
  "改为纯产品置换：无固定费用、佣金 0%"
);
assert(p7?.pricingMode === "commission_only", "纯产品置换 → commission_only");
assert(p7?.commission === 0, "纯产品置换佣金 0%");

const p8 = parseModifyCampaignChangesFromUserMessage("改成纯产品置换合作");
assert(p8?.pricingMode === "commission_only", "只说纯产品置换 → commission_only");
assert(p8?.commission === 0, "只说纯产品置换 → 佣金默认 0%");

console.log(`\n${ok} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
