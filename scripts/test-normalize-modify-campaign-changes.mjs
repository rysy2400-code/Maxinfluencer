#!/usr/bin/env node
import {
  normalizeModifyCampaignChanges,
  parseMoneyNumberToken,
} from "../lib/campaign/normalize-modify-campaign-changes.js";

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

assert(parseMoneyNumberToken("15,450") === 15450, "parseMoneyNumberToken 15,450");
assert(parseMoneyNumberToken(1000) === 1000, "parseMoneyNumberToken number");

const p1 = normalizeModifyCampaignChanges({
  pricingEcpmUsd: 1,
  pricingMaxFlatFeeUsd: 1000,
});
assert(p1.error == null && p1.changes?.pricingMaxFlatFeeUsd === 1000, "eCPM 1 + cap 1000");

const p2 = normalizeModifyCampaignChanges({ budget: "15,450", commission: "0" });
assert(p2.error == null && p2.changes?.budget === 15450, "budget string with comma");
assert(p2.changes?.commission === 0, "commission 0");

const p3 = normalizeModifyCampaignChanges({ platform: ["YouTube", "TikTok"] });
assert(
  Array.isArray(p3.changes?.platform) && p3.changes.platform.length === 2,
  "platform array"
);

const p4 = normalizeModifyCampaignChanges({ budget: "not-a-number" });
assert(p4.error != null, "invalid budget rejected");

const p5 = normalizeModifyCampaignChanges({
  influencerPricing: { ecpmUsd: "5", maxFlatFeeUsd: "2,500" },
});
assert(
  p5.changes?.influencerPricing?.maxFlatFeeUsd === 2500,
  "nested influencerPricing coerce"
);

const p6 = normalizeModifyCampaignChanges({
  productLink: " https://relxnow.fr/ ",
});
assert(
  p6.error == null && p6.changes?.productLink === "https://relxnow.fr/",
  "productLink trim"
);

const p7 = normalizeModifyCampaignChanges({ productLink: "relxnow.fr" });
assert(p7.error != null, "productLink without protocol rejected");

const p8 = normalizeModifyCampaignChanges({
  productLink: "",
});
assert(p8.error != null, "empty productLink rejected");

console.log(`\n${ok} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
