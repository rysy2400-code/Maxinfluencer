#!/usr/bin/env node
import {
  normalizeAllowedCountries,
  countryMatchesPublishLocation,
  resolveAllowedCountriesFromCampaign,
  enrichCampaignInfoCountryFields,
} from "../lib/influencer/campaign-country-codes.js";

const cases = [
  [["美国"], "US", true],
  [["US"], "US", true],
  [["美国", "德国"], "DE", true],
  [["美国"], "GB", false],
  [[], "US", true],
  [["美国"], null, false],
];

let failed = 0;
for (const [allowed, pub, expect] of cases) {
  const got = countryMatchesPublishLocation(pub, allowed);
  if (got !== expect) {
    console.error("FAIL", { allowed, pub, expect, got });
    failed += 1;
  }
}

const info = enrichCampaignInfoCountryFields({ region: ["美国"], platform: "TikTok" });
if (JSON.stringify(info.countries) !== '["US"]' || info.region[0] !== "美国") {
  console.error("FAIL enrich", info);
  failed += 1;
}

if (
  JSON.stringify(resolveAllowedCountriesFromCampaign({ region: "德国" })) !==
  '["DE"]'
) {
  failed += 1;
}

console.log(
  failed === 0
    ? "test-campaign-country-codes: OK"
    : `test-campaign-country-codes: ${failed} failed`
);
process.exit(failed === 0 ? 0 : 1);
