/**
 * 探测 TikTok Affiliate Partner Creator 页 API / DOM 结构（GMV 等）
 *
 * 用法（在 Crawler VM 上，9222 已登录 partner.us.tiktokshop.com）:
 *   node scripts/probe-tiktok-affiliate-creator.mjs detail 7495403384116840923
 *   node scripts/probe-tiktok-affiliate-creator.mjs search "username"
 *   node scripts/probe-tiktok-affiliate-creator.mjs reuse-detail   # 复用已打开的 detail 标签
 *   node scripts/probe-tiktok-affiliate-creator.mjs reuse-list      # 复用已打开的 list 标签
 */
import { chromium } from "playwright";

const GMV_KEY_RE =
  /gmv|gpm|revenue|sales|sold|commission|units|order|performance|metric|stat|amount|currency/i;

function findGmvLikeFields(obj, path = "", out = [], depth = 0) {
  if (depth > 14 || obj == null) return out;
  if (typeof obj !== "object") return out;

  if (Array.isArray(obj)) {
    for (let i = 0; i < Math.min(obj.length, 8); i++) {
      findGmvLikeFields(obj[i], `${path}[${i}]`, out, depth + 1);
    }
    return out;
  }

  for (const [k, v] of Object.entries(obj)) {
    const p = path ? `${path}.${k}` : k;
    if (GMV_KEY_RE.test(k) && v != null && v !== "") {
      const preview =
        typeof v === "object"
          ? JSON.stringify(v).slice(0, 300)
          : String(v).slice(0, 300);
      out.push({ path: p, value: preview });
    }
    if (typeof v === "object" && v !== null) {
      findGmvLikeFields(v, p, out, depth + 1);
    }
  }
  return out;
}

function summarizeApiBody(url, json) {
  const hits = findGmvLikeFields(json);
  return {
    url: url.slice(0, 500),
    topKeys:
      json && typeof json === "object" && !Array.isArray(json)
        ? Object.keys(json).slice(0, 20)
        : [],
    code: json?.code ?? json?.status_code ?? json?.statusCode ?? null,
    message: json?.message ?? json?.msg ?? null,
    gmvHits: hits.slice(0, 40),
    gmvHitCount: hits.length,
  };
}

async function pickPage(context, mode) {
  const pages = context.pages().filter((p) => p.url() && !p.url().startsWith("about:"));
  if (mode === "reuse-detail") {
    const p = pages.find((pg) => pg.url().includes("/affiliate-cmp/creator/detail"));
    if (p) return { page: p, created: false };
  }
  if (mode === "reuse-list") {
    const p = pages.find(
      (pg) =>
        pg.url().includes("/affiliate-cmp/creator") &&
        !pg.url().includes("/detail")
    );
    if (p) return { page: p, created: false };
  }
  const page = await context.newPage();
  return { page, created: true };
}

async function attachNetworkProbe(page, captured) {
  const handler = async (response) => {
    const url = response.url();
    if (response.status() >= 400) return;
    if (!/tiktokshop|tiktokv|byte|partner|affiliate|cmp|oec|seller/i.test(url)) {
      return;
    }
    const ct = (response.headers()["content-type"] || "").toLowerCase();
    if (!ct.includes("json") && !url.includes("/api/")) return;

    try {
      const body = await response.text();
      if (!body || body.length > 2_000_000) return;
      const json = JSON.parse(body);
      captured.push({
        method: response.request().method(),
        status: response.status(),
        ...summarizeApiBody(url, json),
        rawSample: JSON.stringify(json).slice(0, 1200),
      });
    } catch {
      /* ignore */
    }
  };
  page.on("response", handler);
  return () => page.off("response", handler);
}

async function scrapeVisibleMetrics(page) {
  return page.evaluate(() => {
    const text = (document.body?.innerText || "").replace(/\s+/g, " ").trim();
    const lines = (document.body?.innerText || "")
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);

    const metricLines = lines.filter((l) =>
      /gmv|gpm|sold|sales|commission|revenue|units|followers|engagement|video|live|product/i.test(
        l
      )
    );

    const labels = [...document.querySelectorAll("span, div, p, h1, h2, h3, h4, th, td")]
      .map((el) => ({
        tag: el.tagName,
        text: (el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 120),
      }))
      .filter((x) => x.text && /gmv|gpm|sold|commission|revenue|units|sales/i.test(x.text))
      .slice(0, 60);

    const scripts = [...document.querySelectorAll("script")]
      .map((s) => s.textContent || "")
      .filter((t) => t.length > 50 && /gmv|creator|affiliate|oecuid|cid/i.test(t))
      .map((t) => t.slice(0, 800));

    return {
      title: document.title,
      url: location.href,
      textSample: text.slice(0, 2500),
      metricLines: metricLines.slice(0, 80),
      metricLabels: labels,
      scriptSnippets: scripts.slice(0, 5),
    };
  });
}

async function probeDetail(context, cid) {
  const captured = [];
  const { page, created } = await pickPage(context, "reuse-detail");
  const detach = await attachNetworkProbe(page, captured);

  const targetUrl = `https://partner.us.tiktokshop.com/affiliate-cmp/creator/detail?cid=${encodeURIComponent(
    cid
  )}&market=100`;

  try {
    if (!page.url().includes(`/detail?cid=${cid}`)) {
      await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
    } else {
      await page.reload({ waitUntil: "domcontentloaded", timeout: 60000 });
    }
    await page.waitForTimeout(5000);
    for (let i = 0; i < 2; i++) {
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await page.waitForTimeout(1500);
    }
    await page.waitForTimeout(3000);
  } finally {
    detach();
  }

  const dom = await scrapeVisibleMetrics(page);
  const apis = captured
    .filter((a) => a.gmvHitCount > 0 || /creator|detail|profile|search|affiliate|cmp/i.test(a.url))
    .sort((a, b) => b.gmvHitCount - a.gmvHitCount);

  return {
    mode: "detail",
    cid,
    pageUrl: page.url(),
    created,
    dom,
    apiCount: captured.length,
    apis: apis.slice(0, 25),
    allApiUrls: captured.map((a) => `${a.method} ${a.status} ${a.url}`).slice(0, 40),
  };
}

async function probeSearch(context, query) {
  const captured = [];
  const { page, created } = await pickPage(context, "reuse-list");
  const detach = await attachNetworkProbe(page, captured);

  const listUrl = "https://partner.us.tiktokshop.com/affiliate-cmp/creator?market=100";

  try {
    if (!page.url().includes("/affiliate-cmp/creator")) {
      await page.goto(listUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
      await page.waitForTimeout(4000);
    }

    // 尝试定位搜索框
    const searchSelectors = [
      'input[placeholder*="Search"]',
      'input[placeholder*="search"]',
      'input[type="search"]',
      'input[aria-label*="Search"]',
      'input[class*="search"]',
    ];
    let filled = false;
    for (const sel of searchSelectors) {
      const loc = page.locator(sel).first();
      if ((await loc.count()) > 0) {
        await loc.click({ timeout: 5000 }).catch(() => {});
        await loc.fill("");
        await loc.fill(query, { timeout: 8000 });
        await page.keyboard.press("Enter");
        filled = true;
        break;
      }
    }

    if (!filled) {
      // fallback: 任意可见 input
      const anyInput = page.locator("input:visible").first();
      if ((await anyInput.count()) > 0) {
        await anyInput.click().catch(() => {});
        await anyInput.fill(query);
        await page.keyboard.press("Enter");
        filled = true;
      }
    }

    await page.waitForTimeout(6000);
  } finally {
    detach();
  }

  const dom = await scrapeVisibleMetrics(page);
  const apis = captured
    .filter((a) => /search|creator|list|recommend|affiliate|cmp/i.test(a.url))
    .sort((a, b) => b.gmvHitCount - a.gmvHitCount);

  return {
    mode: "search",
    query,
    pageUrl: page.url(),
    created,
    dom,
    apiCount: captured.length,
    apis: apis.slice(0, 25),
    allApiUrls: captured.map((a) => `${a.method} ${a.status} ${a.url}`).slice(0, 40),
  };
}

async function probeReuseOnly(context, mode) {
  const captured = [];
  const { page, created } = await pickPage(context, mode);
  const detach = await attachNetworkProbe(page, captured);
  await page.waitForTimeout(2000);
  detach();

  const dom = await scrapeVisibleMetrics(page);
  const apis = captured.sort((a, b) => b.gmvHitCount - a.gmvHitCount);

  return {
    mode,
    pageUrl: page.url(),
    created,
    dom,
    apiCount: captured.length,
    apis: apis.slice(0, 25),
  };
}

async function main() {
  const mode = process.argv[2] || "reuse-detail";
  const arg = process.argv[3] || "7495403384116840923";
  const endpoint =
    process.env.CDP_ENDPOINT_AFFILIATE ||
    process.env.CDP_ENDPOINT ||
    "http://127.0.0.1:9222";

  const browser = await chromium.connectOverCDP(endpoint, { timeout: 20000 });
  const context = browser.contexts()[0] || (await browser.newContext());

  let result;
  if (mode === "detail") {
    result = await probeDetail(context, arg);
  } else if (mode === "search") {
    result = await probeSearch(context, arg);
  } else if (mode === "reuse-detail" || mode === "reuse-list") {
    result = await probeReuseOnly(context, mode);
  } else {
    throw new Error(`unknown mode: ${mode}`);
  }

  console.log(JSON.stringify(result, null, 2));
  await browser.close().catch(() => {});
}

main().catch((err) => {
  console.error("PROBE_FAILED", err?.message || err);
  process.exit(1);
});
