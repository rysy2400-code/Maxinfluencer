/**
 * 任务级平台路由 + 多平台派单（不访问 DB）
 * node scripts/test-task-search-platform-routing.mjs
 */
import {
  resolveTaskSearchChannels,
  platformPayloadSlug,
  resolveCampaignPlatforms,
} from "../lib/influencer/resolve-campaign-platforms.js";

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

const cases = [
  ["tiktok", { useTikTok: true, useYouTube: false, useInstagram: false }],
  ["youtube", { useTikTok: false, useYouTube: true, useInstagram: false }],
  ["instagram", { useTikTok: false, useYouTube: false, useInstagram: true }],
  ["TikTok", { useTikTok: true, useYouTube: false, useInstagram: false }],
  ["ytb", { useTikTok: false, useYouTube: true, useInstagram: false }],
];

for (const [input, expected] of cases) {
  const got = resolveTaskSearchChannels(input);
  assert(got.useTikTok === expected.useTikTok, `${input} useTikTok`);
  assert(got.useYouTube === expected.useYouTube, `${input} useYouTube`);
  assert(got.useInstagram === expected.useInstagram, `${input} useInstagram`);
  console.log("✓ resolveTaskSearchChannels", input);
}

// 多平台 campaign：tiktok 任务不得因 campaign 含 YouTube 而走 ytb
const multi = resolveTaskSearchChannels("tiktok");
assert(!multi.useYouTube, "tiktok task on TikTok+YouTube campaign must not use YouTube");
console.log("✓ tiktok task ignores campaign platform list");

const platforms = resolveCampaignPlatforms({ platform: ["TikTok", "YouTube"] });
const slugs = platforms.map((p) => platformPayloadSlug(p));
assert(
  JSON.stringify(slugs) === JSON.stringify(["tiktok", "youtube"]),
  `dispatch slugs ${slugs.join(",")}`
);
console.log("✓ heartbeat would dispatch", slugs.length, "tasks per keyword");

console.log("\nAll task platform routing checks passed.");
