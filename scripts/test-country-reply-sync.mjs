import assert from "node:assert/strict";
import {
  extractCountryFromReplyText,
  shouldAskCountryInOutreach,
} from "../lib/influencer/country-reply-sync.js";

assert.equal(
  extractCountryFromReplyText("I'm currently based in Canada.")?.iso,
  "CA"
);
assert.equal(
  extractCountryFromReplyText("We are located in the UK and can ship locally.")?.iso,
  "GB"
);
assert.equal(
  extractCountryFromReplyText("我现在常驻美国，可以合作。")?.iso,
  "US"
);
assert.equal(extractCountryFromReplyText("Thanks for getting back to us.")?.iso, undefined);
assert.equal(extractCountryFromReplyText("I can do it next week.")?.iso, undefined);
assert.equal(
  shouldAskCountryInOutreach({ influencer: { region: "US" }, executionSnapshot: {} }),
  false
);
assert.equal(
  shouldAskCountryInOutreach({ influencer: {}, executionSnapshot: { videoPublishCountry: "GB" } }),
  false
);
assert.equal(
  shouldAskCountryInOutreach({ influencer: {}, executionSnapshot: {} }),
  true
);

console.log("country reply sync tests passed");
