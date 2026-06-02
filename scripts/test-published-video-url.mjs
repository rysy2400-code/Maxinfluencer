/**
 * 已发布视频 URL 解析单元测试
 * node scripts/test-published-video-url.mjs
 */
import {
  parsePublishedVideoUrl,
  resolveExecutionPublishedVideoLink,
} from "../lib/execution/published-video-url.js";
import {
  formatMetricDisplay,
  normalizeMetricsPayload,
} from "../lib/execution/published-video-metrics-format.js";

let failed = 0;

function assert(cond, msg) {
  if (!cond) {
    failed += 1;
    console.error("FAIL:", msg);
  } else {
    console.log("OK:", msg);
  }
}

assert(
  parsePublishedVideoUrl("https://www.tiktok.com/@user/video/7123456789").platform ===
    "tiktok",
  "tiktok url"
);
assert(
  parsePublishedVideoUrl("https://www.instagram.com/reel/ABC123xyz/").shortcode ===
    "ABC123xyz",
  "instagram reel"
);
assert(
  parsePublishedVideoUrl("https://www.youtube.com/watch?v=dQw4w9WgXcQ").videoId ===
    "dQw4w9WgXcQ",
  "youtube watch"
);
assert(
  parsePublishedVideoUrl("https://youtu.be/dQw4w9WgXcQ").platform === "youtube",
  "youtu.be"
);

assert(
  resolveExecutionPublishedVideoLink({
    video_link: "https://www.tiktok.com/@a/video/1",
    last_event: { videoLink: "https://example.com" },
  }) === "https://www.tiktok.com/@a/video/1",
  "video_link column priority"
);

const m = normalizeMetricsPayload({ views: 125000, likes: 8200, comments: 320 });
assert(m.viewsDisplay === "125K", "format 125K");

console.log(`\n${failed ? "FAILED" : "ALL PASSED"} (${failed} failures)`);
process.exit(failed > 0 ? 1 : 0);
