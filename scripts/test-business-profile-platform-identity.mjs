import assert from "node:assert/strict";
import { seedKnownPlatformProfiles } from "../lib/influencer/business-profile-platform-identity.js";

const PROFILE = `# Influencer Business Profile

## Platform Profiles

- TikTok: No account (TikTok unavailable in India)
- Instagram: @tina_pere
- YouTube: Unknown

## Minimum Rates (USD)

| Platform | Content Type | Quantity | Minimum Rate USD | Original Quote | Included / Excluded | Confirmed At |
| --- | --- | ---: | ---: | --- | --- | --- |
| YouTube | Dedicated video | 1 | 200 | "$200 USD dedicated 4–6 minute YouTube video" | Included | 2026-09-06T20:24:22Z |

## Preferred Categories

- Unknown`;

const seeded = seedKnownPlatformProfiles(PROFILE, [
  {
    platform: "youtube",
    username: "mixallin1",
    profileUrl: "https://www.youtube.com/@mixallin1",
  },
]);

assert.match(
  seeded,
  /- YouTube: @mixallin1 \(https:\/\/www\.youtube\.com\/@mixallin1\)/
);
assert.match(seeded, /- Instagram: @tina_pere/);
assert.match(seeded, /- TikTok: No account \(TikTok unavailable in India\)/);
assert.match(seeded, /## Minimum Rates \(USD\)/);
assert.equal(seedKnownPlatformProfiles("", [{ platform: "youtube", username: "x" }]), "");

console.log("business profile platform identity tests passed");
