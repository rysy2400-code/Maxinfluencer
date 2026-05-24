/**
 * 搜索页取前 N 条视频，逐条打开详情页统计 locationCreated 覆盖率
 * 用法: CDP_ENDPOINT=http://127.0.0.1:9222 node scripts/probe-tiktok-search-top-videos-location.js "robot vacuum" 10
 */
import { chromium } from "playwright";

function extractVideoId(url) {
  const m = url.match(/\/video\/(\d+)/);
  return m ? m[1] : null;
}

function readLocationFromUniversal(page, videoId) {
  return page.evaluate((vid) => {
    const uni = document.querySelector(
      'script[id="__UNIVERSAL_DATA_FOR_REHYDRATION__"]'
    );
    if (!uni?.textContent) return { locationCreated: null, source: null };
    try {
      const data = JSON.parse(uni.textContent);
      const item =
        data?.__DEFAULT_SCOPE__?.["webapp.video-detail"]?.itemInfo
          ?.itemStruct ||
        data?.__DEFAULT_SCOPE__?.["webapp.reflow.video.detail"]?.itemInfo
          ?.itemStruct;
      if (item && String(item.id) === String(vid)) {
        return {
          locationCreated: item.locationCreated ?? null,
          source: "UNIVERSAL",
          desc: (item.desc || "").slice(0, 80),
          author: item.author?.uniqueId || null,
        };
      }
    } catch {
      /* ignore */
    }
    return { locationCreated: null, source: null };
  }, videoId);
}

async function collectSearchItems(page, keyword, limit) {
  const captured = [];
  const handler = async (response) => {
    const url = response.url();
    if (!url.includes("/api/search/item/full")) return;
    try {
      const json = JSON.parse(await response.text());
      const items = json.item_list || json.itemList || [];
      if (items.length) captured.push(...items);
    } catch {
      /* ignore */
    }
  };

  page.on("response", handler);
  const searchUrl = `https://www.tiktok.com/search/video?q=${encodeURIComponent(keyword)}&t=${Date.now()}`;
  console.log(`[probe] 搜索: ${keyword}`);
  console.log(`[probe] ${searchUrl}\n`);

  try {
    await page.goto(searchUrl, {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    });
  } catch (e) {
    console.warn(`[probe] goto 警告: ${e.message}`);
  }

  for (let i = 0; i < 6 && captured.length < limit; i++) {
    await page.waitForTimeout(2000);
    await page.evaluate(() => window.scrollBy(0, 800));
  }
  await page.waitForTimeout(2000);
  page.off("response", handler);

  const seen = new Set();
  const rows = [];
  for (const item of captured) {
    const id = item?.id;
    const author = item?.author?.uniqueId;
    if (!id || !author || seen.has(id)) continue;
    seen.add(id);
    rows.push({
      id: String(id),
      author,
      desc: (item.desc || "").slice(0, 60),
      searchApiLocationCreated: item.locationCreated ?? null,
      url: `https://www.tiktok.com/@${author}/video/${id}`,
    });
    if (rows.length >= limit) break;
  }

  if (rows.length < limit) {
    const domLinks = await page.evaluate((lim) => {
      const anchors = [
        ...document.querySelectorAll('a[href*="/video/"]'),
      ];
      const out = [];
      const seenIds = new Set();
      for (const a of anchors) {
        const m = a.href.match(/@([^/]+)\/video\/(\d+)/);
        if (!m) continue;
        const [, author, id] = m;
        if (seenIds.has(id)) continue;
        seenIds.add(id);
        out.push({
          id,
          author,
          url: a.href.split("?")[0],
        });
        if (out.length >= lim) break;
      }
      return out;
    }, limit);

    for (const link of domLinks) {
      if (seen.has(link.id)) continue;
      seen.add(link.id);
      rows.push({
        id: link.id,
        author: link.author,
        desc: "",
        searchApiLocationCreated: null,
        url: link.url,
      });
      if (rows.length >= limit) break;
    }
  }

  return rows;
}

async function probeVideoDetail(page, row) {
  const videoId = row.id;
  let apiLoc = null;

  const handler = async (response) => {
    const u = response.url();
    if (!u.includes("tiktok.com/api/")) return;
    try {
      const text = await response.text();
      if (!text.startsWith("{")) return;
      const json = JSON.parse(text);
      const lists = [
        json.itemList,
        json.item_list,
        json.itemInfo?.itemStruct ? [json.itemInfo.itemStruct] : null,
      ].filter(Boolean);
      for (const list of lists) {
        const arr = Array.isArray(list) ? list : [list];
        const hit = arr.find((x) => String(x?.id) === videoId);
        if (hit?.locationCreated != null && hit.locationCreated !== "") {
          apiLoc = hit.locationCreated;
        }
      }
      if (
        json.itemInfo?.itemStruct?.id &&
        String(json.itemInfo.itemStruct.id) === videoId
      ) {
        const lc = json.itemInfo.itemStruct.locationCreated;
        if (lc != null && lc !== "") apiLoc = lc;
      }
    } catch {
      /* ignore */
    }
  };

  page.on("response", handler);
  try {
    await page.goto(row.url, {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    });
    await page.waitForTimeout(5000);
    try {
      await page.waitForLoadState("networkidle", { timeout: 6000 });
    } catch {
      /* ok */
    }
    await page.waitForTimeout(1500);
  } finally {
    page.off("response", handler);
  }

  const dom = await readLocationFromUniversal(page, videoId);
  const locationCreated =
    dom.locationCreated ?? apiLoc ?? row.searchApiLocationCreated ?? null;
  const hasLocationCreated =
    locationCreated != null && locationCreated !== "";

  return {
    ...row,
    pageUrl: page.url(),
    locationCreated,
    hasLocationCreated,
    detailSource: dom.locationCreated
      ? "UNIVERSAL"
      : apiLoc
        ? "API"
        : row.searchApiLocationCreated
          ? "search_api"
          : null,
    desc: dom.desc || row.desc,
  };
}

async function main() {
  const keyword = process.argv[2] || "robot vacuum";
  const limit = Math.min(Math.max(Number(process.argv[3] || 10), 1), 30);
  const endpoint = process.env.CDP_ENDPOINT || "http://127.0.0.1:9222";

  console.log(`[probe] CDP: ${endpoint}`);
  console.log(`[probe] 取搜索前 ${limit} 条，逐条打开详情页\n`);

  const browser = await chromium.connectOverCDP(endpoint, { timeout: 15000 });
  const context = browser.contexts()[0] || (await browser.newContext());
  const page =
    context.pages().find((p) => p.url().includes("tiktok.com")) ||
    (await context.newPage());

  const searchRows = await collectSearchItems(page, keyword, limit);
  if (!searchRows.length) {
    console.error("⚠️ 未从搜索页获取到视频列表，请确认 9222 Chrome 已登录 TikTok");
    await browser.close();
    process.exit(2);
  }

  console.log(`=== 搜索页前 ${searchRows.length} 条（search/item/full 的 locationCreated）===`);
  const searchWithLoc = searchRows.filter(
    (r) => r.searchApiLocationCreated != null && r.searchApiLocationCreated !== ""
  );
  console.log(
    `  搜索 API 含 locationCreated: ${searchWithLoc.length}/${searchRows.length}\n`
  );

  const results = [];
  for (let i = 0; i < searchRows.length; i++) {
    const row = searchRows[i];
    console.log(`${"─".repeat(60)}`);
    console.log(`[${i + 1}/${searchRows.length}] @${row.author}/video/${row.id}`);
    const r = await probeVideoDetail(page, row);
    results.push(r);
    const flag = r.hasLocationCreated ? "✅" : "❌";
    console.log(
      `  ${flag} locationCreated=${r.hasLocationCreated ? JSON.stringify(r.locationCreated) : "缺失"} (来源: ${r.detailSource || "无"})`
    );
    if (r.desc) console.log(`  desc: ${r.desc}`);
  }

  const withLoc = results.filter((r) => r.hasLocationCreated);
  const codes = {};
  for (const r of withLoc) {
    codes[r.locationCreated] = (codes[r.locationCreated] || 0) + 1;
  }

  console.log(`\n${"=".repeat(60)}`);
  console.log("=== 覆盖率汇总 ===");
  console.log(`关键词: ${keyword}`);
  console.log(`样本数: ${results.length}`);
  console.log(
    `搜索 API locationCreated: ${searchWithLoc.length}/${results.length} (${pct(searchWithLoc.length, results.length)})`
  );
  console.log(
    `详情页 locationCreated:   ${withLoc.length}/${results.length} (${pct(withLoc.length, results.length)})`
  );
  if (Object.keys(codes).length) {
    console.log("详情页国家分布:", codes);
  }

  console.log("\n=== 逐条明细 ===");
  for (const r of results) {
    const loc = r.hasLocationCreated
      ? `locationCreated=${r.locationCreated}`
      : "locationCreated=缺失";
    console.log(
      `  ${r.id} | @${r.author} | ${loc} | 搜索API=${r.searchApiLocationCreated ?? "无"} | ${r.detailSource || "-"}`
    );
  }

  await browser.close();
}

function pct(n, total) {
  if (!total) return "0%";
  return `${((n / total) * 100).toFixed(1)}%`;
}

main().catch((e) => {
  console.error("probe failed:", e.message);
  process.exit(1);
});
