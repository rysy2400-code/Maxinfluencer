#!/usr/bin/env node
/**
 * 远程 IG 网络 + CDP 标签健康检查
 */
import { listCdpPageTargets, verifyCdpTargetHealthy } from "../lib/cdp/cdp-target-page.js";

const CDP = process.env.CDP_ENDPOINT || "http://127.0.0.1:9222";

async function fetchHead(url, proxy) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const headers = {};
    if (proxy) {
      // Node fetch 无原生 proxy；仅用于本机诊断占位
      void proxy;
    }
    const res = await fetch(url, { method: "HEAD", signal: controller.signal });
    return { ok: res.ok, status: res.status };
  } catch (e) {
    return { ok: false, error: e.message };
  } finally {
    clearTimeout(timer);
  }
}

const tabs = await listCdpPageTargets(CDP).catch(() => []);
const igTabs = [];
for (const t of tabs.filter((x) => String(x.url || "").includes("instagram.com"))) {
  const healthy = await verifyCdpTargetHealthy(t).catch(() => false);
  let href = null;
  if (healthy) {
    try {
      const { chromium } = await import("playwright");
      const browser = await chromium.connectOverCDP(CDP, { timeout: 10_000 });
      const page = browser.contexts()[0]?.pages()?.find((p) => !p.isClosed());
      if (page) href = await page.evaluate(() => location.href).catch(() => null);
      await browser.close().catch(() => {});
    } catch {
      href = "(evaluate failed)";
    }
  }
  igTabs.push({ url: t.url, title: t.title, healthy, locationHref: href });
}

console.log(
  JSON.stringify(
    {
      cdpEndpoint: CDP,
      instagramTabs: igTabs,
      note: "healthy=false 或 locationHref=chrome-error 表示 IG 页面不可达",
    },
    null,
    2
  )
);
