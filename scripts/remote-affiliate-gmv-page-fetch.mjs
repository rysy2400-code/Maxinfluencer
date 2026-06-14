import { chromium } from "playwright";

const endpoint = process.env.CDP_ENDPOINT || "http://127.0.0.1:9222";
const handle = process.argv[2] || "una_flor_cubana";
const partnerId = process.env.AFFILIATE_PARTNER_ID || "8647245523056104235";

const browser = await chromium.connectOverCDP(endpoint, { timeout: 20000 });
const context = browser.contexts()[0] || (await browser.newContext());
const page = await context.newPage();

await page.goto("https://partner.us.tiktokshop.com/affiliate-cmp/creator?market=100", {
  waitUntil: "domcontentloaded",
  timeout: 45000,
});
await page.waitForTimeout(3000);

const result = await page.evaluate(async ({ handle, partnerId }) => {
  const params = new URLSearchParams({
    user_language: "en",
    partner_id: partnerId,
    aid: "359713",
    app_name: "i18n_ecom_alliance",
    device_id: "0",
    device_platform: "web",
    cookie_enabled: "true",
  });
  const url = `https://partner.us.tiktokshop.com/api/v1/oec/affiliate/creator/marketplace/4partner/find?${params}`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/plain, */*",
    },
    body: JSON.stringify({
      query: handle,
      query_type: 1,
      pagination: { size: 12, page: 0 },
      filter_params: {},
      algorithm: 1,
    }),
    credentials: "include",
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return {
    pageUrl: location.href,
    httpStatus: res.status,
    code: json?.code,
    message: json?.message || json?.msg,
    listLen: Array.isArray(json?.creator_profile_list) ? json.creator_profile_list.length : null,
    keys: json && typeof json === "object" ? Object.keys(json) : null,
    firstHandle: json?.creator_profile_list?.[0]?.handle,
    rawPreview: text.slice(0, 1200),
  };
}, { handle, partnerId });

console.log(JSON.stringify(result, null, 2));
await page.close().catch(() => {});
await browser.close().catch(() => {});
