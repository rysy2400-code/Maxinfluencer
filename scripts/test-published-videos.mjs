/**
 * 多平台已发布视频（publishedVideos）单元测试
 * node scripts/test-published-videos.mjs
 */
import {
  resolvePublishedVideos,
  mergePublishedVideos,
  applyPublishedMetricsResult,
  aggregatePublishedStats,
  computeTotalCpm,
  buildLegacyPublishedFields,
  publishedVideoTasksFromRow,
  publishedVideoKey,
  upsertPublishedVideosFromUpdate,
} from "../lib/execution/published-videos.js";
import {
  extractPublishedLinksFromEmailBody,
  normalizePublishedLinksInput,
  mergePublishedLinkLists,
} from "../lib/execution/published-link-extraction.js";
import {
  igShortcodeToMediaId,
  igMediaIdToShortcode,
} from "../lib/execution/instagram-shortcode.js";

let failed = 0;

function assert(cond, msg) {
  if (!cond) {
    failed += 1;
    console.error("FAIL:", msg);
  } else {
    console.log("OK:", msg);
  }
}

function assertEq(actual, expected, msg) {
  assert(
    JSON.stringify(actual) === JSON.stringify(expected),
    `${msg} (actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)})`
  );
}

// —— 1. 旧数据兜底：只有单值字段时合成一条 ——
const legacy = resolvePublishedVideos(
  {
    videoLink: "https://vt.tiktok.com/ZSqCu7GtR/",
    promoCode: "CODE1",
    views: "18",
    likes: "3",
    comments: "0",
  },
  {}
);
assertEq(legacy.length, 1, "legacy single → 1 entry");
assertEq(legacy[0].platform, "tiktok", "legacy platform from url");
assertEq(legacy[0].metrics.views, 18, "legacy numeric views");
assertEq(legacy[0].metrics.viewsDisplay, "18", "legacy display views");
assertEq(legacy[0].isPrimary, true, "legacy entry marked primary");

// —— 2. 老数据带多条 deliverablesTimeline ——
const fromTimeline = resolvePublishedVideos({
  videoLink: "https://vt.tiktok.com/ZSqCu7GtR/",
  deliverablesTimeline: [
    {
      kind: "published",
      role: "influencer",
      type: "published_link",
      link: "https://youtu.be/lYfHgrQVFTg?si=x",
      at: "2026-09-14T03:02:56.000Z",
    },
    {
      kind: "published",
      role: "influencer",
      type: "published_link",
      link: "https://www.instagram.com/reel/DdQ5YvdpMUz/",
      at: "2026-09-14T03:02:56.000Z",
    },
    {
      kind: "published",
      role: "influencer",
      type: "published_link",
      link: "https://vt.tiktok.com/ZSqCu7GtR/",
      promoCode: "TK9",
      at: "2026-09-14T14:59:22.000Z",
    },
  ],
});
assertEq(fromTimeline.length, 3, "timeline → 3 entries");
assertEq(
  fromTimeline.map((e) => e.platform),
  ["youtube", "instagram", "tiktok"],
  "fixed platform order youtube→instagram→tiktok"
);
assertEq(fromTimeline[2].promoCode, "TK9", "promoCode from timeline");

// —— 3. 合并：新条目 upsert，不重复、不丢已抓指标 ——
let merged = mergePublishedVideos(
  [
    {
      platform: "youtube",
      url: "https://youtu.be/aaa",
      metrics: { views: 18, likes: 3, comments: 0, updatedAt: "2026-09-15T00:00:00.000Z" },
    },
  ],
  [
    { platform: "youtube", url: "https://youtu.be/aaa?si=dup", promoCode: "YT7" },
    { platform: "instagram", url: "https://www.instagram.com/reel/bbb/" },
    { platform: "tiktok", url: "https://vt.tiktok.com/ccc/" },
  ],
  {}
);
assertEq(merged.length, 3, "merge keeps 3 unique entries");
assertEq(merged[0].promoCode, "YT7", "merge updates promoCode");
assertEq(merged[0].metrics.views, 18, "merge keeps existing metrics");

// —— 4. 指标写回 + 汇总 + 合计 CPM ——
let withMetrics = applyPublishedMetricsResult(merged, {
  videoLink: "https://www.instagram.com/reel/bbb/",
  platform: "instagram",
  metrics: { views: "1.2K", likes: 82, comments: 9, source: "instagram_api" },
});
withMetrics = applyPublishedMetricsResult(withMetrics, {
  videoLink: "https://vt.tiktok.com/ccc/",
  platform: "tiktok",
  error: "TikTok 页面拦截也未拿到数据",
});
const tkEntry = withMetrics.find((e) => e.platform === "tiktok");
assert(
  tkEntry.metricsError && tkEntry.metricsError.message.includes("拦截"),
  "metrics error recorded per platform"
);
assertEq(tkEntry.metrics, null, "no metrics on failed platform");

const stats = aggregatePublishedStats(withMetrics);
assertEq(stats.views, 1218, "aggregate views 18 + 1200");
assertEq(stats.likes, 85, "aggregate likes");
assertEq(computeTotalCpm(700, stats.views), 574.71, "total CPM from aggregate views");

const legacyFields = buildLegacyPublishedFields(withMetrics, {
  feeUsd: 700,
  preferredPlatform: "instagram",
});
assertEq(
  legacyFields.videoLink,
  "https://www.instagram.com/reel/bbb/",
  "legacy primary honors preferred platform"
);
assertEq(legacyFields.views, 1218, "legacy views = aggregate");
assertEq(legacyFields.cpm, 574.71, "legacy cpm = total");

// —— 5. 抓取任务展开：按平台过滤 + 刷新间隔 + 跳过 drive 链接 ——
const row = {
  campaign_id: "CAMP-X",
  tiktok_username: "shinwamystery",
  influencer_id: "48454976794",
  last_event: {
    publishedVideos: [
      {
        platform: "youtube",
        url: "https://youtu.be/lYfHgrQVFTg?si=x",
        metrics: { views: 18, updatedAt: "2026-09-15T10:00:00.000Z" },
      },
      { platform: "instagram", url: "https://www.instagram.com/reel/DdQ5YvdpMUz/" },
      { platform: "tiktok", url: "https://vt.tiktok.com/ZSqCu7GtR/" },
      { platform: "unknown", url: "https://drive.google.com/file/d/abc/view" },
    ],
  },
};
const tasksAll = publishedVideoTasksFromRow(row, {
  refreshHours: 6,
  now: Date.parse("2026-09-15T12:00:00Z"),
});
assertEq(
  tasksAll.map((t) => t.platform),
  ["instagram", "tiktok"],
  "tasks skip drive link and fresh youtube (within refresh window)"
);
const tasksIg = publishedVideoTasksFromRow(row, {
  platformFilter: "instagram",
  refreshHours: 6,
  now: Date.parse("2026-09-15T12:00:00Z"),
});
assertEq(tasksIg.map((t) => t.platform), ["instagram"], "platform filter");

// —— 6. 去重键 ——
assert(
  publishedVideoKey({ platform: "tiktok", url: "https://vt.tiktok.com/ABC/" }) ===
    publishedVideoKey({ platform: "tiktok", url: "https://vt.tiktok.com/ABC" }),
  "key ignores trailing slash"
);
assert(
  publishedVideoKey({ platform: "youtube", url: "https://youtu.be/xyz?si=1" }) ===
    "youtube:xyz",
  "key prefers video id"
);

// —— 7. 邮件正文多平台抽取（真实 case: shinwamystery）——
// Instagram shortcode ↔ 数字 media id（私有接口 /api/v1/media/{id}/info/ 需要数字 id）
assertEq(
  igShortcodeToMediaId("DdQ5YvdpMUz"),
  "3985938059104666931",
  "ig shortcode → media id (verified against live API)"
);
assertEq(
  igMediaIdToShortcode("3985938059104666931"),
  "DdQ5YvdpMUz",
  "ig media id → shortcode round trip"
);
assertEq(igShortcodeToMediaId("bad!char"), null, "ig shortcode rejects invalid chars");

// 7.1 落库合并：两次回传（先 YouTube+Instagram，后 TikTok）→ 3 条、时间线不重复
const firstUpdate = upsertPublishedVideosFromUpdate({
  lastEvent: {},
  timeline: [],
  incoming: [
    { platform: "youtube", url: "https://youtu.be/lYfHgrQVFTg?si=HoHotk6A3ozzSxoB" },
    { platform: "instagram", url: "https://www.instagram.com/reel/DdQ5YvdpMUz/?stkn=x" },
  ],
  preferredPlatform: "instagram",
  feeUsd: 700,
  publishedAt: "2026-09-14T03:02:56.000Z",
  source: "influencer_email",
  emailEventId: 3705847,
  savedAt: "2026-09-14T03:05:00.000Z",
});
assertEq(firstUpdate.publishedVideos.length, 2, "first update stores 2 platforms");
assertEq(firstUpdate.appended.length, 2, "first update appends 2 timeline entries");
assertEq(
  firstUpdate.publishedVideos.find((e) => e.platform === "instagram")?.isPrimary,
  true,
  "primary prefers campaign main platform (instagram)"
);

const secondUpdate = upsertPublishedVideosFromUpdate({
  lastEvent: { publishedVideos: firstUpdate.publishedVideos },
  timeline: firstUpdate.deliverablesTimeline,
  incoming: [{ platform: "tiktok", url: "https://vt.tiktok.com/ZSqCu7GtR/" }],
  preferredPlatform: "instagram",
  feeUsd: 700,
  publishedAt: "2026-09-14T14:59:22.000Z",
  source: "influencer_email",
  emailEventId: 3712834,
  savedAt: "2026-09-14T15:16:50.000Z",
});
assertEq(secondUpdate.publishedVideos.length, 3, "second update → 3 platforms");
assertEq(
  secondUpdate.publishedVideos.map((e) => e.platform),
  ["youtube", "instagram", "tiktok"],
  "ordering is YouTube → Instagram → TikTok"
);
assertEq(secondUpdate.deliverablesTimeline.length, 3, "timeline has 3 published entries");

// 7.2 幂等：重复回传同样的链接不再追加时间线、不再新增条目
const repeatUpdate = upsertPublishedVideosFromUpdate({
  lastEvent: { publishedVideos: secondUpdate.publishedVideos },
  timeline: secondUpdate.deliverablesTimeline,
  incoming: [
    { platform: "youtube", url: "https://youtu.be/lYfHgrQVFTg?si=dup" },
    { platform: "instagram", url: "https://www.instagram.com/reel/DdQ5YvdpMUz/" },
    { platform: "tiktok", url: "https://vt.tiktok.com/ZSqCu7GtR/" },
  ],
  preferredPlatform: "instagram",
  feeUsd: 700,
  savedAt: "2026-09-15T00:00:00.000Z",
});
assertEq(repeatUpdate.publishedVideos.length, 3, "repeat update stays 3 platforms");
assertEq(repeatUpdate.appended.length, 0, "repeat update appends nothing");
assertEq(repeatUpdate.deliverablesTimeline.length, 3, "timeline stays 3 entries");
assertEq(repeatUpdate.legacy.videoLink, "https://www.instagram.com/reel/DdQ5YvdpMUz/", "legacy videoLink = primary");

const timelineWithMetrics = resolvePublishedVideos({
  videoLink: "https://vt.tiktok.com/ZSqCu7GtR/",
  views: "18",
  likes: "3",
  comments: "0",
  metricsUpdatedAt: "2026-09-15T01:00:00.000Z",
  deliverablesTimeline: [
    { kind: "published", link: "https://youtu.be/lYfHgrQVFTg", at: "2026-09-14T03:02:56.000Z" },
    { kind: "published", link: "https://vt.tiktok.com/ZSqCu7GtR/", at: "2026-09-14T14:59:22.000Z" },
  ],
});
assertEq(timelineWithMetrics.length, 2, "timeline + legacy metrics: 2 entries");
assertEq(
  timelineWithMetrics.find((e) => e.platform === "tiktok")?.metrics?.views,
  18,
  "legacy metrics attach to matching platform entry"
);
assertEq(
  timelineWithMetrics.find((e) => e.platform === "youtube")?.metrics,
  null,
  "other platform entries keep no metrics"
);

const shinwaBody = `Hi Bin

The contest submission is complete, and I have just published the video on
YouTube and Instagram. Here are the live links:

YouTube
https://youtu.be/lYfHgrQVFTg?si=HoHotk6A3ozzSxoB

Instagram
https://www.instagram.com/reel/DdQ5YvdpMUz/?stkn=czlhZWNhamM5MTVp

As for TikTok, I will post it tomorrow.
`;
const bodyLinks = extractPublishedLinksFromEmailBody(shinwaBody);
assertEq(
  bodyLinks.map((l) => l.platform),
  ["youtube", "instagram"],
  "extract youtube + instagram from email body"
);
assertEq(
  bodyLinks[0].url,
  "https://youtu.be/lYfHgrQVFTg?si=HoHotk6A3ozzSxoB",
  "extract keeps full url"
);
assertEq(
  extractPublishedLinksFromEmailBody("https://vt.tiktok.com/ZSqCu7GtR/").map(
    (l) => l.platform
  ),
  ["tiktok"],
  "extract tiktok short link"
);
assertEq(
  extractPublishedLinksFromEmailBody(
    "https://www.instagram.com/shinwamystery?stkn=NnRsajllMGxpZmVy&utm_source=qr"
  ).length,
  0,
  "profile urls are not published videos"
);
assertEq(
  extractPublishedLinksFromEmailBody(
    "https://drive.google.com/file/d/1ZDjBZDo8rMvxRoQaCm0wB6OnOgWvZIbC/view"
  ).length,
  0,
  "drive links are not published videos"
);

const mergedLinks = mergePublishedLinkLists(
  [{ platform: "youtube", url: "https://youtu.be/aaa" }],
  [
    { platform: null, url: "https://youtu.be/aaa", promoCode: "YT7" },
    { platform: "tiktok", url: "https://vt.tiktok.com/bbb/" },
  ]
);
assertEq(mergedLinks.length, 2, "merge link lists dedupes by url");
assertEq(mergedLinks[0].promoCode, "YT7", "merge link lists fills promoCode");

assertEq(
  normalizePublishedLinksInput([
    { platform: "YouTube", url: "https://youtu.be/aaa" },
    { platform: "ig", url: "https://www.instagram.com/reel/bbb/" },
    { platform: "tiktok", url: "https://vt.tiktok.com/ccc/", promoCode: "TK1" },
  ]).map((l) => l.platform),
  ["youtube", "instagram", "tiktok"],
  "normalize llm publishedLinks platform names"
);

console.log(`\n${failed ? "FAILED" : "ALL PASSED"} (${failed} failures)`);
process.exit(failed > 0 ? 1 : 0);
