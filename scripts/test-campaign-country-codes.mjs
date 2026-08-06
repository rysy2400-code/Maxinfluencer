#!/usr/bin/env node
import {
  normalizeAllowedCountries,
  countryMatchesPublishLocation,
  resolveAllowedCountriesFromCampaign,
  enrichCampaignInfoCountryFields,
  isRecognizedCountryRegion,
  formatCountryForDisplay,
  isUnknownCountryValue,
} from "../lib/influencer/campaign-country-codes.js";

const cases = [
  [["美国"], "US", true],
  [["US"], "US", true],
  [["美国", "德国"], "DE", true],
  [["法国"], "FR", true],
  [["France"], "FR", true],
  [["美国"], "GB", false],
  [[], "US", true],
  [["美国"], null, false],
];

let failed = 0;

if (isRecognizedCountryRegion("火星") || normalizeAllowedCountries(["火星"]).length) {
  console.error("FAIL unrecognized 火星 should not map");
  failed += 1;
}

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

const frInfo = enrichCampaignInfoCountryFields({
  region: ["France", "德国"],
  platform: "Instagram",
});
if (JSON.stringify(frInfo.countries) !== '["FR","DE"]') {
  console.error("FAIL fr+de countries", frInfo.countries);
  failed += 1;
}
if (!frInfo.region.includes("法国") || !frInfo.region.includes("德国")) {
  console.error("FAIL fr+de region zh", frInfo.region);
  failed += 1;
}

if (formatCountryForDisplay("DE") !== "德国") {
  console.error("FAIL formatCountryForDisplay DE");
  failed += 1;
}
if (formatCountryForDisplay("德国") !== "德国") {
  console.error("FAIL formatCountryForDisplay 德国");
  failed += 1;
}
if (formatCountryForDisplay(null) !== null || formatCountryForDisplay("") !== null) {
  console.error("FAIL formatCountryForDisplay empty");
  failed += 1;
}
if (formatCountryForDisplay("country_unknown") !== null) {
  console.error("FAIL formatCountryForDisplay country_unknown");
  failed += 1;
}
if (!isUnknownCountryValue("country_unknown") || !isUnknownCountryValue(null)) {
  console.error("FAIL isUnknownCountryValue sentinel");
  failed += 1;
}

const modifyPathFix = enrichCampaignInfoCountryFields({
  region: ["美国", "德国"],
  platform: "Instagram",
});
if (JSON.stringify(modifyPathFix.countries) !== '["US","DE"]') {
  console.error("FAIL enrich after modify (no stale countries)", modifyPathFix.countries);
  failed += 1;
}
if (
  JSON.stringify(
    resolveAllowedCountriesFromCampaign({
      region: ["美国", "德国"],
      countries: ["AU"],
    })
  ) !== '["AU"]'
) {
  console.error("FAIL resolve should prefer persisted countries ISO");
  failed += 1;
}

console.log(
  failed === 0
    ? "test-campaign-country-codes: OK"
    : `test-campaign-country-codes: ${failed} failed`
);
process.exit(failed === 0 ? 0 : 1);
