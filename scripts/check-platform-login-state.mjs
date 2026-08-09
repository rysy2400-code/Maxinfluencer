/**
 * 检查 9222 Chrome 上 TikTok / Instagram / YouTube / X / Affiliate 登录态
 * 用法: node scripts/check-platform-login-state.mjs
 */
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

async function probePage(context, url, loginPatterns, loggedInPatterns = []) {
  const page = await context.newPage();
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
    await page.waitForTimeout(3000);
    const finalUrl = page.url();
    const title = await page.title().catch(() => "");
    const bodyText = await page
      .evaluate(() => (document.body?.innerText || "").slice(0, 4000))
      .catch(() => "");

    const loginLike =
      loginPatterns.some((re) => re.test(finalUrl) || re.test(bodyText)) ||
      /log in|sign in|登录|登入/i.test(bodyText.slice(0, 800));
    const loggedInLike =
      loggedInPatterns.some((re) => re.test(finalUrl) || re.test(bodyText)) ||
      (!loginLike && !/login|passport|accounts\.google/i.test(finalUrl));

    return {
      url: finalUrl,
      title,
      loggedIn: loggedInLike && !loginLike,
      loginHint: loginLike,
    };
  } finally {
    await page.close().catch(() => {});
  }
}

const browser = await chromium.connectOverCDP(endpoint, { timeout: 20000 });
const context = browser.contexts()[0] || (await browser.newContext());

const [tiktok, instagram, youtube, x, partner] = await Promise.all([
  probePage(
    context,
    "https://www.tiktok.com/",
    [/login|passport|account\/login/i],
    [/tiktok\.com\/(foryou|following|@[^/?#]+)/i]
  ),
  probePage(
    context,
    "https://www.instagram.com/",
    [/accounts\/login|login\?/i],
    [/instagram\.com\/(direct|explore|reels)/i]
  ),
  probePage(
    context,
    "https://www.youtube.com/",
    [/accounts\.google\.com|ServiceLogin/i],
    [/youtube\.com\/(feed|watch|results)/i]
  ),
  probePage(
    context,
    "https://x.com/home",
    [/i\/flow\/login|account\/access/i],
    [/x\.com\/(home|explore)/i]
  ),
  probePage(
    context,
    "https://partner.us.tiktokshop.com/affiliate-cmp/creator?market=100",
    [/login|passport|account\/login/i],
    [/affiliate-cmp\/creator/i]
  ),
]);

const affiliate = await fetchAffiliateMetricsByUsername(context, "charlasios");

const report = {
  cdpEndpoint: endpoint,
  platforms: {
    tiktok: tiktok,
    instagram: instagram,
    youtube: youtube,
    x: x,
    affiliatePartner: partner,
  },
  affiliateGmvProbe: {
    ok: affiliate.ok,
    reason: affiliate.reason,
    gmv: affiliate.gmv,
    unitsSold: affiliate.unitsSold,
    gmvDisplay: affiliate.gmvDisplay,
  },
  allLoggedIn:
    tiktok.loggedIn &&
    instagram.loggedIn &&
    youtube.loggedIn &&
    x.loggedIn &&
    partner.loggedIn &&
    affiliate.ok,
};

console.log(JSON.stringify(report, null, 2));
await browser.close().catch(() => {});
