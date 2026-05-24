/**
 * 在 CDP Chrome 中打开单条/多条 TikTok 视频页，检查发布地址字段
 * 用法: CDP_ENDPOINT=http://127.0.0.1:9222 node scripts/probe-tiktok-video-location.js <url1> [url2...]
 */
import { chromium } from "playwright";

const LOC_KEY_RE = /location|address|poi|region|country|city|geo/i;

function extractVideoId(url) {
  const m = url.match(/\/video\/(\d+)/);
  return m ? m[1] : null;
}

function findLocFields(obj, path = "", out = [], depth = 0) {
  if (depth > 14 || obj == null || typeof obj !== "object") return out;
  if (Array.isArray(obj)) {
    for (let i = 0; i < Math.min(obj.length, 3); i++) {
      findLocFields(obj[i], `${path}[${i}]`, out, depth + 1);
    }
    return out;
  }
  for (const [k, v] of Object.entries(obj)) {
    const p = path ? `${path}.${k}` : k;
    if (LOC_KEY_RE.test(k) && v != null && v !== "") {
      const preview =
        typeof v === "object"
          ? JSON.stringify(v).slice(0, 200)
          : String(v).slice(0, 200);
      out.push({ path: p, value: preview });
    }
    if (typeof v === "object" && v !== null) findLocFields(v, p, out, depth + 1);
  }
  return out;
}

function summarizeItem(item) {
  if (!item) return null;
  const top = {};
  for (const [k, v] of Object.entries(item)) {
    if (LOC_KEY_RE.test(k)) top[k] = v;
  }
  return {
    id: item.id,
    desc: (item.desc || "").slice(0, 80),
    locationCreated: item.locationCreated ?? null,
    hasLocationCreated:
      item.locationCreated != null && item.locationCreated !== "",
    topLevelLoc: top,
    poi: item.poi || item.poiInfo || null,
  };
}

function pickItemFromJson(json, videoId) {
  if (!json || typeof json !== "object") return null;
  if (json.itemInfo?.itemStruct) return json.itemInfo.itemStruct;
  if (json.itemStruct) return json.itemStruct;
  if (json.itemList?.length) {
    const hit = json.itemList.find((x) => String(x.id) === videoId);
    return hit || json.itemList[0];
  }
  if (json.item_list?.length) {
    const hit = json.item_list.find((x) => String(x.id) === videoId);
    return hit || json.item_list[0];
  }
  if (json.item && (String(json.item.id) === videoId || !videoId))
    return json.item;
  if (json.aweme_detail) return json.aweme_detail;
  return null;
}

async function probeOneUrl(page, url) {
  const videoId = extractVideoId(url);
  const apis = [];
  const apiUrls = [];
  const handler = async (response) => {
    const u = response.url();
    if (response.status() >= 300 && response.status() < 400) return;
    if (!u.includes("tiktok.com/api/") && !u.includes("tiktokv.com")) return;
    apiUrls.push(u.split("?")[0].slice(-90));
    try {
      const text = await response.text();
      if (!text || text[0] !== "{") return;
      const json = JSON.parse(text);
      const item = pickItemFromJson(json, videoId);
      const locHits = findLocFields(json).filter(
        (h) =>
          !h.path.includes("abTest") &&
          !h.path.includes("i18n") &&
          !h.path.includes("enable_poi_recall")
      );
      apis.push({
        url: u.split("?")[0].slice(-90),
        item: summarizeItem(item),
        locHitCount: locHits.length,
        locHits: locHits.slice(0, 12),
      });
    } catch {
      /* ignore */
    }
  };

  page.on("response", handler);
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForTimeout(6000);
    try {
      await page.waitForLoadState("networkidle", { timeout: 8000 });
    } catch {
      /* ok */
    }
    await page.waitForTimeout(2000);
  } finally {
    page.off("response", handler);
  }

  let embedded = { locHits: [], itemStruct: null };
  try {
    embedded = await page.evaluate((vid) => {
    const out = { locHits: [], itemStruct: null };
    const scan = (obj, path = "", depth = 0) => {
      if (depth > 14 || !obj || typeof obj !== "object") return;
      if (Array.isArray(obj)) {
        obj.slice(0, 5).forEach((x, i) => scan(x, `${path}[${i}]`, depth + 1));
        return;
      }
      for (const [k, v] of Object.entries(obj)) {
        const p = path ? `${path}.${k}` : k;
        if (
          /locationCreated|poiInfo|poi_name|address/i.test(k) &&
          v != null &&
          v !== "" &&
          !/abTest|i18n|enable_poi|locationApi/i.test(p)
        ) {
          out.locHits.push({
            path: p,
            value:
              typeof v === "object"
                ? JSON.stringify(v).slice(0, 150)
                : String(v).slice(0, 150),
          });
        }
        if (typeof v === "object") scan(v, p, depth + 1);
      }
    };
    const uni = document.querySelector(
      'script[id="__UNIVERSAL_DATA_FOR_REHYDRATION__"]'
    );
    if (uni?.textContent) {
      try {
        const data = JSON.parse(uni.textContent);
        scan(data, "UNIVERSAL");
        const item =
          data?.__DEFAULT_SCOPE__?.["webapp.video-detail"]?.itemInfo
            ?.itemStruct ||
          data?.__DEFAULT_SCOPE__?.["webapp.reflow.video.detail"]?.itemInfo
            ?.itemStruct;
        if (item && String(item.id) === String(vid)) {
          out.itemStruct = {
            id: item.id,
            locationCreated: item.locationCreated ?? null,
            poi: item.poi || item.poiInfo || null,
            desc: (item.desc || "").slice(0, 80),
          };
        }
      } catch {}
    }
    return out;
  }, videoId);
  } catch (e) {
    embedded = { locHits: [], itemStruct: null, evaluateError: e.message };
  }

  const domItem = embedded.itemStruct
    ? {
        id: embedded.itemStruct.id,
        desc: embedded.itemStruct.desc,
        locationCreated: embedded.itemStruct.locationCreated ?? null,
        hasLocationCreated:
          embedded.itemStruct.locationCreated != null &&
          embedded.itemStruct.locationCreated !== "",
        topLevelLoc: {},
        poi: embedded.itemStruct.poi,
      }
    : null;

  const bestItem =
    apis.map((a) => a.item).find((x) => x?.id && String(x.id) === videoId) ||
    domItem ||
    apis.map((a) => a.item).find((x) => x?.hasLocationCreated) ||
    apis.map((a) => a.item).find(Boolean) ||
    domItem;

  return {
    url,
    videoId,
    pageUrl: page.url(),
    bestItem,
    domItem,
    apis: apis.filter((a) => a.item || a.locHitCount > 0).slice(0, 10),
    apiUrlList: [...new Set(apiUrls)].slice(0, 15),
    domLocHits: embedded.locHits.slice(0, 15),
    evaluateError: embedded.evaluateError || null,
  };
}

async function main() {
  const urls = process.argv.slice(2).filter((u) => u.startsWith("http"));
  if (!urls.length) {
    console.error("请提供至少一个 TikTok 视频 URL");
    process.exit(1);
  }

  const endpoint = process.env.CDP_ENDPOINT || "http://127.0.0.1:9222";
  console.log(`[probe] CDP: ${endpoint}`);
  console.log(`[probe] 共 ${urls.length} 个视频\n`);

  const browser = await chromium.connectOverCDP(endpoint, { timeout: 15000 });
  const context = browser.contexts()[0] || (await browser.newContext());
  const page = await context.newPage();

  const results = [];
  for (let i = 0; i < urls.length; i++) {
    console.log(`\n${"=".repeat(72)}`);
    console.log(`[${i + 1}/${urls.length}] ${urls[i]}`);
    const r = await probeOneUrl(page, urls[i]);
    results.push(r);

    if (r.bestItem?.hasLocationCreated) {
      console.log(`✅ 有发布地址: locationCreated = ${JSON.stringify(r.bestItem.locationCreated)}`);
    } else {
      console.log("❌ 未发现 locationCreated（API item 层）");
    }
    if (r.bestItem) {
      console.log("item 摘要:", JSON.stringify(r.bestItem, null, 2));
    }
    if (r.apiUrlList?.length) {
      console.log(`\n拦截到的 API (${r.apiUrlList.length}):`);
      r.apiUrlList.forEach((u) => console.log(`  - ${u}`));
    }
    if (r.apis.length) {
      console.log(`\n含 item/地址 的 API (${r.apis.length}):`);
      for (const a of r.apis) {
        console.log(`  - ${a.url} | locHits=${a.locHitCount}`);
        if (a.item) console.log(`    item:`, JSON.stringify(a.item));
        for (const h of a.locHits.slice(0, 5)) {
          console.log(`    ${h.path} => ${h.value}`);
        }
      }
    }
    if (r.domItem) {
      console.log("\nDOM itemStruct:", JSON.stringify(r.domItem, null, 2));
    }
    if (r.evaluateError) {
      console.log("⚠️ DOM 解析失败:", r.evaluateError);
    }
    if (r.domLocHits.length) {
      console.log("\nDOM 内嵌数据中的地址字段:");
      for (const h of r.domLocHits) {
        console.log(`  ${h.path} => ${h.value}`);
      }
    }
  }

  console.log(`\n${"=".repeat(72)}`);
  console.log("=== 汇总 ===");
  for (const r of results) {
    const flag = r.bestItem?.hasLocationCreated ? "✅ 有" : "❌ 无";
    console.log(`${flag} locationCreated | video/${r.videoId}`);
  }

  await page.close();
  await browser.close();
}

main().catch((e) => {
  console.error("probe failed:", e.message);
  process.exit(1);
});
