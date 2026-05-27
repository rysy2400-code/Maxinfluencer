import {
  resolveCampaignPlatforms,
  pickNextDispatchPlatform,
  platformPayloadSlug,
  isYouTubePlatform,
} from "../lib/influencer/resolve-campaign-platforms.js";

const cases = [
  [{ platform: ["TikTok", "Instagram", "YouTube"] }, ["TikTok", "Instagram", "YouTube"]],
  [{ platform: "ytb" }, ["YouTube"]],
  [{ platform: "Ins" }, ["Instagram"]],
  [{}, ["TikTok"]],
];

for (const [input, expected] of cases) {
  const got = resolveCampaignPlatforms(input);
  const ok = JSON.stringify(got) === JSON.stringify(expected);
  console.log(ok ? "✓" : "✗", input, "=>", got);
}

let last = null;
const mockQuery = async () => [{ payload: JSON.stringify({ platform: last }) }];
for (let i = 0; i < 6; i++) {
  last = await pickNextDispatchPlatform(
    "camp-1",
    ["TikTok", "Instagram", "YouTube"],
    mockQuery
  );
  console.log("rotate", i, last);
}

console.log("slug IG", platformPayloadSlug("Instagram"));
console.log("slug YT", platformPayloadSlug("YouTube"));
console.log("isYT", isYouTubePlatform("ytb"));
