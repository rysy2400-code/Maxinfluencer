/**
 * 在 Crawler VM 上验证 enrich 流水线中的 Affiliate GMV 步骤（不触发 LLM 分析）
 *
 * 用法:
 *   CDP_ENDPOINT=http://127.0.0.1:9222 node scripts/test-affiliate-enrich-integration.mjs una_flor_cubana
 */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import { enrichInfluencerProfiles } from "../lib/tools/influencer-functions/search-and-extract-influencers.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
dotenv.config({ path: path.join(projectRoot, ".env") });
dotenv.config({ path: path.join(projectRoot, ".env.local") });

const username = (process.argv[2] || "una_flor_cubana").replace(/^@/, "").trim();

const records = await enrichInfluencerProfiles(
  [
    {
      username,
      profileUrl: `https://www.tiktok.com/@${username}`,
      platform: "TikTok",
    },
  ],
  {
    maxCount: 1,
    concurrency: 1,
    enableLiveMatch: false,
    platform: "tiktok",
  }
);

const rec = records?.[0] || {};
const summary = {
  username: rec.username,
  profileExtracted: Boolean(rec.profile_data?.success ?? rec.profile_data?.userInfo),
  gmv: rec.gmv ?? null,
  gmvDisplay: rec.gmvDisplay ?? null,
  unitsSold: rec.unitsSold ?? null,
  gmvSource: rec.gmvSource ?? null,
  affiliateCreatorOecuid: rec.affiliateCreatorOecuid ?? null,
  affiliateMetrics: rec.affiliateMetrics
    ? {
        gmv: rec.affiliateMetrics.gmv,
        unitsSold: rec.affiliateMetrics.unitsSold,
        handle: rec.affiliateMetrics.handle,
      }
    : null,
};

console.log(JSON.stringify({ ok: summary.gmv != null || summary.unitsSold != null, summary }, null, 2));
process.exit(summary.gmv != null || summary.unitsSold != null ? 0 : 1);
