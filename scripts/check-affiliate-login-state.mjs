/** 检查 9222 Affiliate 登录态 + 模拟 worker 路径拉 GMV */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import { chromium } from "playwright";
import { fetchAffiliateMetricsByUsername } from "../lib/tools/influencer-functions/enrich-affiliate-metrics.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
dotenv.config({ path: path.join(projectRoot, ".env") });
dotenv.config({ path: path.join(projectRoot, ".env.local") });

const endpoint =
  process.env.CDP_ENDPOINT_ENRICH ||
  process.env.CDP_ENDPOINT ||
  "http://127.0.0.1:9222";

const browser = await chromium.connectOverCDP(endpoint, { timeout: 20000 });
const context = browser.contexts()[0];

// 登录态探测：访问 partner 首页看是否跳转 login
const page = await context.newPage();
let partnerUrl = "";
try {
  await page.goto("https://partner.us.tiktokshop.com/affiliate-cmp/creator?market=100", {
    waitUntil: "domcontentloaded",
    timeout: 45000,
  });
  await page.waitForTimeout(3000);
  partnerUrl = page.url();
} finally {
  await page.close().catch(() => {});
}

const handles = ["una_flor_cubana", "statusmarz", "charlasios"];
const results = {};
for (const h of handles) {
  results[h] = await fetchAffiliateMetricsByUsername(context, h);
}

console.log(
  JSON.stringify(
    {
      cdpEndpoint: endpoint,
      partnerPageUrl: partnerUrl,
      partnerLoggedIn: !/login|passport|account\/login/i.test(partnerUrl),
      results: Object.fromEntries(
        Object.entries(results).map(([k, v]) => [
          k,
          { ok: v.ok, reason: v.reason, gmv: v.gmv, unitsSold: v.unitsSold },
        ])
      ),
    },
    null,
    2
  )
);

await browser.close().catch(() => {});
