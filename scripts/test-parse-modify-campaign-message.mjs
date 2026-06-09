#!/usr/bin/env node
import {
  parseModifyCampaignChangesFromUserMessage,
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

console.log(`\n${ok} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
