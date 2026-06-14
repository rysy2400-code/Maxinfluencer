import { chromium } from "playwright";

const endpoint = process.env.CDP_ENDPOINT || "http://127.0.0.1:9222";
const handle = process.argv[2] || "una_flor_cubana";
const partnerId = process.env.AFFILIATE_PARTNER_ID || "8647245523056104235";

const browser = await chromium.connectOverCDP(endpoint, { timeout: 20000 });
const context = browser.contexts()[0] || (await browser.newContext());

const url =
  `https://partner.us.tiktokshop.com/api/v1/oec/affiliate/creator/marketplace/4partner/find?` +
  new URLSearchParams({
    user_language: "en",
    partner_id: partnerId,
    aid: "359713",
    app_name: "i18n_ecom_alliance",
    device_id: "0",
    device_platform: "web",
    cookie_enabled: "true",
  });

const response = await context.request.post(url, {
  data: {
    query: handle,
    query_type: 1,
    pagination: { size: 12, page: 0 },
    filter_params: {},
    algorithm: 1,
  },
  headers: {
    "content-type": "application/json",
    accept: "application/json, text/plain, */*",
    origin: "https://partner.us.tiktokshop.com",
    referer: "https://partner.us.tiktokshop.com/affiliate-cmp/creator?market=100",
  },
  timeout: 20000,
});

const text = await response.text();
let json;
try { json = JSON.parse(text); } catch { json = null; }

console.log(JSON.stringify({
  handle,
  partnerId,
  httpStatus: response.status(),
  code: json?.code,
  message: json?.message || json?.msg,
  listLen: Array.isArray(json?.creator_profile_list) ? json.creator_profile_list.length : null,
  firstHandle: json?.creator_profile_list?.[0]?.handle,
  rawPreview: text.slice(0, 800),
}, null, 2));

await browser.close().catch(() => {});
