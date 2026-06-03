/**
 * 测试 IG「账户简介」国家提取
 * 用法: CDP_ENDPOINT=http://127.0.0.1:9222 node scripts/test-ig-about-country.mjs thejunglebadger
 */
import { chromium } from "playwright";
import { extractInstagramAboutCountryFromPage } from "../lib/tools/influencer-functions/instagram/extract-instagram-about-country.js";

const username = process.argv[2] || "thejunglebadger";
const endpoint = process.env.CDP_ENDPOINT || "http://127.0.0.1:9222";

const browser = await chromium.connectOverCDP(endpoint, { timeout: 20000 });
const context = browser.contexts()[0];
let page = context.pages().find((p) => p.url().includes("instagram.com"));
if (!page) page = await context.newPage();

console.log(`\n[test] @${username} CDP=${endpoint}\n`);

const result = await extractInstagramAboutCountryFromPage(page, username, {
  onWbloksCountry: (c) => console.log(`[live wbloks] ${c}`),
});

console.log(JSON.stringify(result, null, 2));
console.log(
  result.success
    ? `\n✅ 账户所在地: ${result.accountCountry} → ISO ${result.accountCountryIso ?? result.videoPublishCountry} (来源: ${result.source})`
    : `\n❌ 未获取到国家: ${result.error}`
);

await browser.close();
process.exit(result.success ? 0 : 1);
