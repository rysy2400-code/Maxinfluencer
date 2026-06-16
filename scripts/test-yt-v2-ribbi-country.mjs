#!/usr/bin/env node
/**
 * 重跑 Ribbi campaign 近期 country_unknown 红人，验证 YouTube Lite v2 /about 国家解析
 */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import { chromium } from "playwright";
import { queryTikTok } from "../lib/db/mysql-tiktok.js";
import {
  extractYoutubeChannelLite,
  loadYoutubeChannelAboutFromPage,
} from "../lib/tools/influencer-functions/youtube/extract-youtube-channel-lite.js";
import { acquireYoutubeInnertubeSession } from "../lib/tools/influencer-functions/youtube/innertube-direct-fetch.js";
import { normalizeAllowedCountries } from "../lib/influencer/campaign-country-codes.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
dotenv.config({ path: path.join(root, ".env") });
dotenv.config({ path: path.join(root, ".env.local") });

process.env.SCRAPER_MODE = "lite";
process.env.LITE_DISABLE_SCREENSHOTS = "true";
process.env.LITE_ENRICH_SCREENSHOTS = "false";

const args = process.argv.slice(2);
let limit = 10;
let campaignPattern = "Ribbi";
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--limit" && args[i + 1]) limit = Math.min(Number(args[++i]) || 10, 20);
  else if (args[i] === "--campaign" && args[i + 1]) campaignPattern = args[++i];
}

async function findCampaign(pattern) {
  return queryTikTok(
    `
    SELECT id, region, platform, product_info, campaign_info
    FROM tiktok_campaign
    WHERE status != 'deleted'
      AND (
        JSON_UNQUOTE(JSON_EXTRACT(product_info, '$.productName')) LIKE ?
        OR JSON_UNQUOTE(JSON_EXTRACT(product_info, '$.brandName')) LIKE ?
        OR JSON_UNQUOTE(JSON_EXTRACT(campaign_info, '$.brandName')) LIKE ?
        OR JSON_UNQUOTE(JSON_EXTRACT(campaign_info, '$.productName')) LIKE ?
      )
    ORDER BY updated_at DESC
    LIMIT 5
    `,
    [`%${pattern}%`, `%${pattern}%`, `%${pattern}%`, `%${pattern}%`]
  );
}

async function fetchRecentYoutubeTasks(campaignId) {
  return queryTikTok(
    `
    SELECT id, keyword, started_at, finished_at, progress_skip_country_unknown_count
    FROM tiktok_influencer_search_task
    WHERE campaign_id = ? AND platform = 'youtube'
    ORDER BY created_at DESC
    LIMIT 15
    `,
    [campaignId]
  );
}

async function fetchUnknownYoutubeInfluencers(campaignId, max) {
  const tasks = await fetchRecentYoutubeTasks(campaignId);
  const taskWithSkips = tasks.find((t) => Number(t.progress_skip_country_unknown_count) > 0);
  const since = taskWithSkips?.started_at || tasks[0]?.started_at || null;

  let rows = [];
  if (since) {
    rows = await queryTikTok(
      `
      SELECT username, tiktok_user_id AS channel_id, video_publish_country, profile_url, last_crawled_at
      FROM TikTok_influencer
      WHERE profile_url LIKE '%youtube.com%'
        AND (video_publish_country IS NULL OR video_publish_country = '')
        AND last_crawled_at >= ?
      ORDER BY last_crawled_at DESC
      LIMIT ?
      `,
      [since, max * 3]
    );
  }

  if (rows.length < max) {
    const more = await queryTikTok(
      `
      SELECT username, tiktok_user_id AS channel_id, video_publish_country, profile_url, last_crawled_at
      FROM TikTok_influencer
      WHERE profile_url LIKE '%youtube.com%'
        AND (video_publish_country IS NULL OR video_publish_country = '')
      ORDER BY last_crawled_at DESC
      LIMIT ?
      `,
      [max * 3]
    );
    const seen = new Set(rows.map((r) => r.username));
    for (const r of more) {
      if (!seen.has(r.username)) {
        rows.push(r);
        seen.add(r.username);
      }
    }
  }

  return rows.slice(0, max);
}

async function main() {
  const campaigns = await findCampaign(campaignPattern);
  if (!campaigns.length) {
    console.error(`未找到 campaign 匹配 "${campaignPattern}"`);
    process.exit(2);
  }
  const campaign = campaigns[0];
  const productName =
    campaign.product_info?.productName ||
    (typeof campaign.product_info === "string"
      ? JSON.parse(campaign.product_info)?.productName
      : null);
  console.log(`Campaign: id=${campaign.id} region=${campaign.region} product=${productName || "(json)"}`);

  const influencers = await fetchUnknownYoutubeInfluencers(campaign.id, limit);
  if (!influencers.length) {
    console.error("未找到近期无国家的 YouTube 红人记录");
    process.exit(2);
  }

  console.log(`待测 ${influencers.length} 位（v2 goto /about）`);

  const cdp = process.env.CDP_ENDPOINT || "http://127.0.0.1:9222";
  const browser = await chromium.connectOverCDP(cdp, { timeout: 25_000 });
  const context = browser.contexts()[0];
  const session = await acquireYoutubeInnertubeSession(context, { persistent: false });
  const page = session.page;

  const regionRaw =
    campaign.region ||
    (typeof campaign.campaign_info === "string"
      ? JSON.parse(campaign.campaign_info)?.region
      : campaign.campaign_info?.region) ||
    "US";
  const allowed = normalizeAllowedCountries(
    String(regionRaw)
      .split(/[,，、]/)
      .map((s) => s.trim())
      .filter(Boolean)
  );

  const results = [];
  for (const inf of influencers) {
    const username = String(inf.username || "").replace(/^@/, "");
    const channelId = inf.channel_id || null;
    const aboutOnly = await loadYoutubeChannelAboutFromPage(page, username, channelId);
    const full = await extractYoutubeChannelLite(page, username, {
      channelId,
      allowedCountriesIso: allowed,
    });
    results.push({
      username,
      before: inf.video_publish_country || null,
      aboutCountry: aboutOnly.videoPublishCountry,
      aboutSource: aboutOnly.countrySource,
      afterCountry: full.videoPublishCountry,
      skippedReason: full.skippedReason || null,
      videos: full.videos?.length ?? 0,
    });
    console.log(
      `${aboutOnly.videoPublishCountry ? "✅" : "❓"} @${username} about=${aboutOnly.videoPublishCountry || "null"}(${aboutOnly.countrySource || "-"}) skip=${full.skippedReason || "-"} videos=${full.videos?.length ?? 0}`
    );
  }

  await session.dispose().catch(() => {});
  await browser.close().catch(() => {});

  const withCountry = results.filter((r) => r.aboutCountry).length;
  const passedGate = results.filter((r) => !r.skippedReason && r.videos > 0).length;
  console.log("\n--- 汇总 ---");
  console.log(
    JSON.stringify(
      {
        campaignId: campaign.id,
        tested: results.length,
        aboutCountryRate: `${withCountry}/${results.length} (${Math.round((withCountry / results.length) * 100)}%)`,
        fullEnrichRate: `${passedGate}/${results.length}`,
        allowedCountries: allowed,
        results,
      },
      null,
      2
    )
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
