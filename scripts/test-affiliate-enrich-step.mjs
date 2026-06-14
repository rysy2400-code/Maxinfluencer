/**
 * 验证 enrich 流水线中的 Affiliate 步骤（跳过 TikTok 主页提取，只测 CDP + fetch + merge）
 */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import { chromium } from "playwright";
import {
  fetchAffiliateMetricsByUsername,
  applyAffiliateMetricsToRecord,
} from "../lib/tools/influencer-functions/enrich-affiliate-metrics.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
dotenv.config({ path: path.join(projectRoot, ".env") });
dotenv.config({ path: path.join(projectRoot, ".env.local") });

const username = (process.argv[2] || "una_flor_cubana").replace(/^@/, "").trim();
const endpoint =
  process.env.CDP_ENDPOINT_ENRICH ||
  process.env.CDP_ENDPOINT ||
  "http://127.0.0.1:9222";

const browser = await chromium.connectOverCDP(endpoint, { timeout: 20000 });
const context = browser.contexts()[0] || (await browser.newContext());

const mergedRecord = {
  username,
  profileUrl: `https://www.tiktok.com/@${username}`,
  platform: "TikTok",
  profile_data: { success: true, userInfo: { username } },
};

const affiliateResult = await fetchAffiliateMetricsByUsername(context, username);
applyAffiliateMetricsToRecord(mergedRecord, affiliateResult);

console.log(
  JSON.stringify(
    {
      ok: mergedRecord.gmv != null || mergedRecord.unitsSold != null,
      affiliateResult: {
        ok: affiliateResult.ok,
        reason: affiliateResult.reason,
        gmv: affiliateResult.gmv,
        unitsSold: affiliateResult.unitsSold,
      },
      mergedRecord: {
        gmv: mergedRecord.gmv,
        gmvDisplay: mergedRecord.gmvDisplay,
        unitsSold: mergedRecord.unitsSold,
        gmvSource: mergedRecord.gmvSource,
        affiliateCreatorOecuid: mergedRecord.affiliateCreatorOecuid,
      },
    },
    null,
    2
  )
);

await browser.close().catch(() => {});
process.exit(mergedRecord.gmv != null || mergedRecord.unitsSold != null ? 0 : 1);
