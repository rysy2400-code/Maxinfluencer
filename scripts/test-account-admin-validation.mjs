import assert from "node:assert/strict";
import {
  makeManualReference,
  normalizeAccountRole,
  normalizeIsoDate,
  normalizeRequiredText,
  normalizeUsdAmount,
  validateSixDigitPassword,
} from "../lib/admin/account-admin-validation.js";

assert.equal(normalizeRequiredText("  Acme  ", 10), "Acme");
assert.equal(normalizeRequiredText("", 10), null);
assert.equal(normalizeRequiredText("12345", 4), null);
assert.equal(validateSixDigitPassword("012345"), true);
assert.equal(validateSixDigitPassword("12345"), false);
assert.equal(validateSixDigitPassword("12345a"), false);
assert.equal(normalizeAccountRole("member"), "member");
assert.equal(normalizeAccountRole("company_admin"), "company_admin");
assert.equal(normalizeAccountRole("admin"), null);
assert.equal(normalizeUsdAmount("1"), "1.00");
assert.equal(normalizeUsdAmount("2913.83"), "2913.83");
assert.equal(normalizeUsdAmount("0"), null);
assert.equal(normalizeUsdAmount("1.001"), null);
assert.equal(normalizeUsdAmount("-1"), null);
assert.equal(normalizeIsoDate("2026-07-18"), "2026-07-18");
assert.equal(normalizeIsoDate("2026-02-30"), null);
assert.equal(makeManualReference(new Date("2026-07-18T01:02:03Z"), () => 0), "MANUAL-20260718010203-000000");

console.log("account admin validation: 18 assertions passed");
