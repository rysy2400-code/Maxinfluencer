import {
  resolveCampaignPlatforms,
  parseCampaignPlatforms,
  normalizeCampaignInfoPlatforms,
  pickNextDispatchPlatform,
  platformPayloadSlug,
  isYouTubePlatform,
} from "../lib/influencer/resolve-campaign-platforms.js";

const cases = [
  [{ platform: ["TikTok", "Instagram", "YouTube"] }, ["TikTok", "Instagram", "YouTube"]],
  [{ platform: "ytb" }, ["YouTube"]],
  [{ platform: "Ins" }, ["Instagram"]],
  [{ platform: "ytb和tk" }, ["YouTube", "TikTok"]],
  [{ platform: "ytb、tk和ins" }, ["YouTube", "TikTok", "Instagram"]],
  [{ platform: ["ytb", "tk", "ins"] }, ["YouTube", "TikTok", "Instagram"]],
  [{ platform: "tk" }, ["TikTok"]],
  [{}, ["TikTok"]],
];

const parseCases = [
  ["ytb", ["YouTube"]],
  ["ytb和tk", ["YouTube", "TikTok"]],
  ["ytb、tk和ins", ["YouTube", "TikTok", "Instagram"]],
  ["ytb,tk,ins", ["YouTube", "TikTok", "Instagram"]],
];
const dbCases = [
  [{ platform: "ytb和tk" }, { platform: ["YouTube", "TikTok"] }],
  [{ platform: ["ytb", "tk"] }, { platform: ["YouTube", "TikTok"] }],
];
for (const [input, expected] of dbCases) {
  const got = normalizeCampaignInfoPlatforms(input);
  const ok = JSON.stringify(got.platform) === JSON.stringify(expected.platform);
  console.log(ok ? "✓ db" : "✗ db", JSON.stringify(input.platform), "=>", got.platform);
}

for (const [input, expected] of parseCases) {
  const got = parseCampaignPlatforms(input);
  const ok = JSON.stringify(got) === JSON.stringify(expected);
  console.log(ok ? "✓ parse" : "✗ parse", JSON.stringify(input), "=>", got);
}

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
