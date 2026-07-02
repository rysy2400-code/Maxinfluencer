#!/usr/bin/env node
/** 诊断 TikTok Lite 主页 enrich：user/detail + post/item_list signed API */
import { acquireTiktokApiSession } from "../lib/tools/influencer-functions/tiktok/tiktok-direct-fetch.js";
import { extractTiktokProfileLite } from "../lib/tools/influencer-functions/tiktok/extract-tiktok-profile-lite.js";

const handle = (process.argv[2] || "crosby.kicks").replace(/^@/, "");
const endpoint =
  process.env.CDP_ENDPOINT_ENRICH ||
  process.env.TT_LITE_ENRICH_CDP ||
  "http://127.0.0.1:9223";

console.log(`[probe] endpoint=${endpoint} handle=@${handle}`);

const { page, dispose } = await acquireTiktokApiSession(null, { endpointKey: endpoint });
try {
  const result = await extractTiktokProfileLite(page, handle);
  console.log("[probe] success", result.success);
  console.log("[probe] followers", result.userInfo?.followers);
  console.log("[probe] secUid", result.userInfo?.secUid ? "yes" : "no");
  console.log("[probe] videos", result.videos?.length || 0);
  console.log("[probe] avgViews", result.statistics?.avgViews);
  console.log("[probe] extractMode", result.extractMode);
  if (result.videos?.length) {
    const sample = result.videos.slice(0, 3).map((v) => ({
      id: v.videoId,
      views: v.views?.count,
    }));
    console.log("[probe] sampleVideos", sample);
  }
  if (!result.success) console.log("[probe] error", result.error);
} finally {
  await dispose();
}
