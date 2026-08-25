import assert from "node:assert/strict";
import {
  isExplicitDoNotContact,
  isWithinBusinessProfileWindow,
  roundSystemSuggestedPrice,
} from "../lib/influencer/business-profile.js";

assert.equal(roundSystemSuggestedPrice(499, 1), 650);
assert.equal(roundSystemSuggestedPrice(500, 1), 650);
assert.equal(roundSystemSuggestedPrice(501, 1), 660);
assert.equal(roundSystemSuggestedPrice(500, 2), 1300);
assert.equal(roundSystemSuggestedPrice(null, 1), null);

const now = new Date("2026-07-28T00:00:00.000Z");
assert.equal(isWithinBusinessProfileWindow("2026-06-28T00:00:00.000Z", now), true);
assert.equal(isWithinBusinessProfileWindow("2026-01-29T00:00:00.000Z", now), true);
assert.equal(isWithinBusinessProfileWindow("2026-01-28T23:59:59.000Z", now), false);
assert.equal(isExplicitDoNotContact("Please remove this address from your outreach list."), true);
assert.equal(isExplicitDoNotContact("We cannot do this campaign, but keep us in mind."), false);

console.log("Influencer business profile tests passed.");
