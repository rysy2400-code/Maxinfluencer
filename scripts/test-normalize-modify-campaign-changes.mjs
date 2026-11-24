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

const p9 = normalizeModifyCampaignChanges({ countries: ["FR", "de", "KR"] });
assert(
  p9.error == null &&
    JSON.stringify(p9.changes?.countries) === JSON.stringify(["FR", "DE", "KR"]),
  "countries ISO array normalized"
);
assert(
  Array.isArray(p9.changes?.region) &&
    p9.changes?.region.includes("法国") &&
    p9.changes?.region.includes("韩国"),
  "region display generated from countries"
);

const p10 = normalizeModifyCampaignChanges({ countries: ["UK"] });
assert(p10.error != null, "UK rejected as non-official ISO");

const p11 = normalizeModifyCampaignChanges({ countries: ["AQ", "US"] });
assert(p11.error != null, "AQ rejected as not ad-targetable");

const p12 = normalizeModifyCampaignChanges({ countries: ["CN", "US"] });
assert(p12.error != null, "CN rejected from whitelist");

const multiRegion = normalizeModifyCampaignChanges({
  region: "法国、比利时、瑞士、摩洛哥、德国、意大利、墨西哥、西班牙、葡萄牙、巴西 、阿根廷、哥伦比亚、智利、秘鲁、委内瑞拉、厄瓜多尔、危地马拉、多米尼加、玻利维亚、洪都拉斯、巴拉圭、萨尔瓦多、尼加拉瓜、哥斯达黎加、乌拉圭、巴拿马、古巴、赤道几内亚、日本、土耳其、韩国",
});
assert(
  multiRegion.error == null &&
    Array.isArray(multiRegion.changes?.region) &&
    multiRegion.changes.region.length >= 30 &&
    multiRegion.changes.region.at(-1) === "韩国",
  "multi-country region string expands to full list (bug fix)"
);

console.log(`\n${ok} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
