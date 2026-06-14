/** 复用已打开的 detail 标签 reload 并抓 API */
import { chromium } from "playwright";

const cid = process.argv[2] || "7495403384116840923";
const endpoint = process.env.CDP_ENDPOINT || "http://127.0.0.1:9222";
const browser = await chromium.connectOverCDP(endpoint, { timeout: 20000 });
const ctx = browser.contexts()[0];
const page =
  ctx.pages().find((p) => p.url().includes("/creator/detail")) ||
  (await ctx.newPage());
const hits = [];

const handler = async (response) => {
  const url = response.url();
  if (!/partner\.us\.tiktokshop\.com\/api\//.test(url)) return;
  if (response.status() >= 400) return;
  try {
    const json = JSON.parse(await response.text());
    hits.push({
      method: response.request().method(),
      url: url.split("?")[0],
      postData: response.request().postData()?.slice(0, 1200),
      code: json.code,
      msg: json.message || json.msg,
      hasGmv: JSON.stringify(json).toLowerCase().includes("gmv"),
      sample: JSON.stringify(json).slice(0, 3000),
    });
  } catch {}
};
page.on("response", handler);

const target = `https://partner.us.tiktokshop.com/affiliate-cmp/creator/detail?cid=${cid}&market=100&partner_id=8647245523056104235`;
await page.goto(target, { waitUntil: "domcontentloaded", timeout: 90000 });
await page.waitForTimeout(12000);
page.off("response", handler);

console.log(
  JSON.stringify(
    {
      pageUrl: page.url(),
      hits: hits.filter((h) => h.hasGmv || /oec\/affiliate|creator/.test(h.url)),
      allPartnerApiPaths: [...new Set(hits.map((h) => h.url))],
    },
    null,
    2
  )
);
await browser.close().catch(() => {});
