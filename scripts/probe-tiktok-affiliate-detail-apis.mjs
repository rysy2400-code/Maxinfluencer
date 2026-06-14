/**
 * 抓取 detail 页全部 partner API（含 POST body）
 */
import { chromium } from "playwright";

const cid = process.argv[2] || "7495403384116840923";
const endpoint = process.env.CDP_ENDPOINT || "http://127.0.0.1:9222";

const browser = await chromium.connectOverCDP(endpoint, { timeout: 20000 });
const ctx = browser.contexts()[0] || (await browser.newContext());
const page = await ctx.newPage();
const hits = [];

page.on("response", async (response) => {
  const url = response.url();
  if (!url.includes("partner.us.tiktokshop.com/api/")) return;
  if (response.status() >= 400) return;
  try {
    const text = await response.text();
    const json = JSON.parse(text);
    hits.push({
      method: response.request().method(),
      url: url.split("?")[0],
      query: url.includes("?") ? url.split("?")[1].slice(0, 400) : "",
      postData: response.request().postData()?.slice(0, 1500) || null,
      code: json.code ?? json.status_code,
      msg: json.message || json.msg,
      keys: json && typeof json === "object" ? Object.keys(json).slice(0, 15) : [],
      dataKeys:
        json?.data && typeof json.data === "object" && !Array.isArray(json.data)
          ? Object.keys(json.data).slice(0, 30)
          : [],
      sample: JSON.stringify(json).slice(0, 2500),
    });
  } catch {
    /* ignore */
  }
});

await page.goto(
  `https://partner.us.tiktokshop.com/affiliate-cmp/creator/detail?cid=${cid}&market=100`,
  { waitUntil: "networkidle", timeout: 90000 }
).catch(async () => {
  await page.goto(
    `https://partner.us.tiktokshop.com/affiliate-cmp/creator/detail?cid=${cid}&market=100`,
    { waitUntil: "domcontentloaded", timeout: 90000 }
  );
});
await page.waitForTimeout(10000);

console.log(JSON.stringify({ cid, pageUrl: page.url(), hits }, null, 2));
await page.close().catch(() => {});
await browser.close().catch(() => {});
