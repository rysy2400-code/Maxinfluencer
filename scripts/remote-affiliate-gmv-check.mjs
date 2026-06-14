/**
 * 远程 Crawler VM 一键检测 Affiliate GMV 拉取（CDP 9222 + partner API）
 * 用法: node scripts/remote-affiliate-gmv-check.mjs
 */
import { chromium } from "playwright";

const endpoint = process.env.CDP_ENDPOINT || "http://127.0.0.1:9222";
const handles = ["una_flor_cubana", "statusmarz", "charlasios"];
const partnerId = process.env.AFFILIATE_PARTNER_ID || "8647245523056104235";

function unwrap(node) {
  if (node == null || typeof node !== "object" || Array.isArray(node)) return node;
  if ("value" in node) return unwrap(node.value);
  return node;
}

function parseGmv(wrapped) {
  const inner =
    wrapped != null && typeof wrapped === "object" && !Array.isArray(wrapped) && "value" in wrapped
      ? wrapped.value
      : wrapped;
  if (inner != null && typeof inner === "object" && !Array.isArray(inner)) {
    const n = Number(inner.value);
    return Number.isFinite(n) ? { gmv: n, gmvDisplay: inner.format || `$${n}` } : { gmv: null, gmvDisplay: null };
  }
  const n = Number(unwrap(wrapped));
  return Number.isFinite(n) ? { gmv: n, gmvDisplay: `$${n}` } : { gmv: null, gmvDisplay: null };
}

async function fetchOne(context, handle) {
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
  try {
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
    const status = response.status();
    let json;
    try {
      json = await response.json();
    } catch {
      return { ok: false, reason: "invalid_json", httpStatus: status };
    }
    if (status === 401 || status === 403) return { ok: false, reason: "login_required", httpStatus: status };
    if (json?.code !== 0 && json?.code !== "0") {
      return { ok: false, reason: `api_error_${json?.code}`, message: json?.message || json?.msg, httpStatus: status };
    }
    const list = json?.creator_profile_list;
    if (!Array.isArray(list) || !list.length) return { ok: false, reason: "not_found", httpStatus: status };
    const hit = list.find((item) => String(unwrap(item?.handle) || "").toLowerCase() === handle.toLowerCase());
    if (!hit) return { ok: false, reason: "handle_not_matched", httpStatus: status };
    const { gmv, gmvDisplay } = parseGmv(hit.med_gmv_revenue);
    const unitsRaw = unwrap(hit.units_sold);
    const unitsSold = unitsRaw != null && unitsRaw !== "" && Number.isFinite(Number(unitsRaw)) ? Number(unitsRaw) : null;
    const ok = gmv != null || unitsSold != null;
    return { ok, reason: ok ? null : "unauthorized_or_empty", gmv, gmvDisplay, unitsSold, httpStatus: status };
  } catch (err) {
    return { ok: false, reason: err?.message?.includes("Timeout") ? "timeout" : "request_failed", message: err?.message };
  }
}

const out = { cdpEndpoint: endpoint, partnerLoggedIn: null, partnerPageUrl: null, results: {} };

let browser;
try {
  browser = await chromium.connectOverCDP(endpoint, { timeout: 20000 });
  const context = browser.contexts()[0] || (await browser.newContext());

  const page = await context.newPage();
  try {
    await page.goto("https://partner.us.tiktokshop.com/affiliate-cmp/creator?market=100", {
      waitUntil: "domcontentloaded",
      timeout: 45000,
    });
    await page.waitForTimeout(2500);
    out.partnerPageUrl = page.url();
    out.partnerLoggedIn = !/login|passport|account\/login/i.test(page.url());
  } finally {
    await page.close().catch(() => {});
  }

  for (const h of handles) {
    out.results[h] = await fetchOne(context, h);
  }
} catch (err) {
  out.error = err?.message || String(err);
} finally {
  await browser?.close().catch(() => {});
}

const anyOk = Object.values(out.results).some((r) => r?.ok);
console.log(JSON.stringify(out, null, 2));
process.exit(anyOk ? 0 : 1);
