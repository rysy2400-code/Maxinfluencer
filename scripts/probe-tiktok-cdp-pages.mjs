#!/usr/bin/env node
/**
 * 通过 CDP 9222/9223 探测 TikTok 相关页面是否可访问（非香港跳转）
 */
import { chromium } from "playwright";

const PAGES = [
  { name: "search", url: "https://www.tiktok.com/search/video?q=travel" },
  { name: "video", url: "https://www.tiktok.com/@tiktok/video/7234567890123456789" },
  { name: "profile", url: "https://www.tiktok.com/@tiktok" },
  { name: "affiliate", url: "https://affiliate.tiktok.com/" },
];

const ENDPOINTS = [
  process.env.CDP_ENDPOINT || "http://127.0.0.1:9222",
  process.env.CDP_ENDPOINT_ENRICH || "http://127.0.0.1:9223",
];

async function ensureCdp(endpoint) {
  const r = await fetch(`${endpoint}/json/version`, { signal: AbortSignal.timeout(8000) });
  return r.ok;
}

async function probeEndpoint(endpoint) {
  const port = endpoint.includes("9223") ? "9223" : "9222";
  console.log(`\n=== CDP ${port} (${endpoint}) ===`);
  const browser = await chromium.connectOverCDP(endpoint, { timeout: 15000 });
  const context = browser.contexts()[0] || (await browser.newContext());
  const results = [];
  try {
    for (const item of PAGES) {
      const page = await context.newPage();
      let status = "fail";
      let detail = "";
      try {
        const resp = await page.goto(item.url, {
          waitUntil: "domcontentloaded",
          timeout: 45000,
        });
        const finalUrl = page.url();
        const httpStatus = resp?.status?.() ?? 0;
        if (finalUrl.includes("/hk/about")) {
          status = "fail";
          detail = `hk_redirect final=${finalUrl}`;
        } else if (httpStatus >= 200 && httpStatus < 400) {
          status = "ok";
          detail = `http=${httpStatus} final=${finalUrl.slice(0, 80)}`;
        } else if (httpStatus === 404 && item.name === "video") {
          status = "ok";
          detail = `http=404 (expected for fake video id) final=${finalUrl.slice(0, 80)}`;
        } else {
          status = httpStatus >= 400 ? "warn" : "ok";
          detail = `http=${httpStatus} final=${finalUrl.slice(0, 80)}`;
        }
      } catch (e) {
        detail = e.message?.slice(0, 120) || String(e);
      } finally {
        await page.close().catch(() => {});
      }
      results.push({ page: item.name, status, detail });
      console.log(`  [${status}] ${item.name}: ${detail}`);
    }
  } finally {
    // 勿 browser.close()：会关掉远程 Chrome 守护进程
  }
  const ok = results.every((r) => r.status === "ok" || r.status === "warn");
  return { port, ok, results };
}

async function main() {
  const all = [];
  for (const ep of ENDPOINTS) {
    const up = await ensureCdp(ep);
    if (!up) {
      console.error(`CDP not ready: ${ep}`);
      process.exit(2);
    }
    all.push(await probeEndpoint(ep));
  }
  const pass = all.every((x) => x.ok);
  console.log(`\n=== SUMMARY ===`);
  for (const x of all) {
    const counts = x.results.reduce(
      (a, r) => {
        a[r.status] = (a[r.status] || 0) + 1;
        return a;
      },
      {}
    );
    console.log(`CDP ${x.port}: ${pass && x.ok ? "PASS" : x.ok ? "PASS" : "FAIL"} ${JSON.stringify(counts)}`);
  }
  process.exit(pass ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
