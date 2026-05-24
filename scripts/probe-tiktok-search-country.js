/**
 * 在已登录 CDP Chrome 中探测关键词搜索页是否含红人国家/地区字段
 * 用法: node scripts/probe-tiktok-search-country.js "soup tray"
 */
import { chromium } from "playwright";

const COUNTRY_KEY_RE =
  /country|region|location|geo|nation|province|city|area|locale/i;

function findCountryLikeFields(obj, path = "", out = [], depth = 0) {
  if (depth > 12 || obj == null) return out;
  if (typeof obj !== "object") return out;
  if (Array.isArray(obj)) {
    for (let i = 0; i < Math.min(obj.length, 5); i++) {
      findCountryLikeFields(obj[i], `${path}[${i}]`, out, depth + 1);
    }
    return out;
  }
  for (const [k, v] of Object.entries(obj)) {
    const p = path ? `${path}.${k}` : k;
    if (COUNTRY_KEY_RE.test(k) && v != null && v !== "") {
      const preview =
        typeof v === "object"
          ? JSON.stringify(v).slice(0, 200)
          : String(v).slice(0, 200);
      out.push({ path: p, value: preview });
    }
    if (typeof v === "object" && v !== null) {
      findCountryLikeFields(v, p, out, depth + 1);
    }
  }
  return out;
}

async function detectLoginRequired(page) {
  const url = page.url();
  if (url.includes("/login")) return true;
  const body = await page.evaluate(() => {
    const text = document.body?.innerText || "";
    const hasLoginBtn =
      !!document.querySelector('[data-e2e="top-login-button"]') ||
      !!document.querySelector('a[href*="/login"]');
    const hasSearchResults =
      !!document.querySelector('[data-e2e="search_video-item"]') ||
      !!document.querySelector('[data-e2e="search-card-video"]') ||
      !!document.querySelector('[class*="DivItemContainer"]');
    return {
      hasLoginBtn,
      hasSearchResults,
      snippet: text.slice(0, 500),
    };
  });
  if (body.hasLoginBtn && !body.hasSearchResults) return true;
  if (/log in|登录|sign up/i.test(body.snippet) && !body.hasSearchResults)
    return true;
  return false;
}

async function main() {
  const keyword = process.argv[2] || "soup tray";
  const endpoint =
    process.env.CDP_ENDPOINT_ENRICH ||
    process.env.CDP_ENDPOINT ||
    "http://127.0.0.1:9223";

  const captured = {
    searchItemFull: [],
    searchOther: [],
    recommend: [],
  };

  const browser = await chromium.connectOverCDP(endpoint, { timeout: 10000 });
  const context = browser.contexts()[0] || (await browser.newContext());
  const page =
    context.pages().find((p) => p.url().includes("tiktok.com")) ||
    (await context.newPage());

  const handler = async (response) => {
    const url = response.url();
    if (response.status() >= 300 && response.status() < 400) return;
    if (!url.includes("tiktok.com/api/")) return;
    try {
      const json = JSON.parse(await response.text());
      if (url.includes("/api/search/item/full")) {
        captured.searchItemFull.push({ url, json });
        const n = json.item_list?.length || json.itemList?.length || 0;
        console.log(`[probe] search/item/full (${n} items)`);
      } else if (url.includes("/api/search/")) {
        captured.searchOther.push({ url, json });
        const n =
          json.item_list?.length ||
          json.itemList?.length ||
          json.data?.length ||
          0;
        if (n) console.log(`[probe] search other: ${url.split("?")[0].slice(-60)} (${n})`);
      } else if (url.includes("/api/recommend/")) {
        captured.recommend.push({ url, json });
      }
    } catch {
      /* ignore */
    }
  };

  page.on("response", handler);

  const searchUrl = `https://www.tiktok.com/search/video?q=${encodeURIComponent(keyword)}&t=${Date.now()}`;
  console.log(`\n[probe] 使用页面: ${page.url()}`);
  console.log(`[probe] 导航到搜索页: ${keyword}`);
  console.log(`[probe] URL: ${searchUrl}\n`);

  try {
    await page.goto(searchUrl, {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    });
  } catch (e) {
    console.warn(`[probe] goto 警告: ${e.message}`);
  }

  await page.waitForTimeout(3000);

  if (await detectLoginRequired(page)) {
    page.off("response", handler);
    console.log("\n⚠️ 需要登录 TikTok");
    console.log("请在已连接 CDP 的 Chrome 窗口中手动登录 TikTok，然后重新运行:");
    console.log(
      `  node scripts/probe-tiktok-search-country.js "${keyword}"`
    );
    console.log(`\n当前页面: ${page.url()}`);
    await browser.close();
    process.exit(2);
  }

  for (let i = 0; i < 6; i++) {
    await page.evaluate(() => window.scrollBy(0, 800));
    await page.waitForTimeout(2000);
    if (captured.searchItemFull.length > 0) break;
  }
  await page.waitForTimeout(3000);
  page.off("response", handler);

  console.log("\n=== 拦截统计 ===");
  console.log({
    searchItemFull: captured.searchItemFull.length,
    searchOther: captured.searchOther.length,
    recommend: captured.recommend.length,
  });

  const analyzeItems = (items, label) => {
    if (!items?.length) {
      console.log(`\n--- ${label}: 无数据 ---`);
      return;
    }
    console.log(`\n--- ${label}: ${items.length} 条视频 ---`);
    const withLoc = items.filter((i) => i.locationCreated);
    console.log(`  含 locationCreated: ${withLoc.length}/${items.length}`);
    if (withLoc.length) {
      const codes = {};
      withLoc.forEach((i) => {
        codes[i.locationCreated] = (codes[i.locationCreated] || 0) + 1;
      });
      console.log("  locationCreated 分布:", codes);
      console.log(
        "  样例:",
        withLoc.slice(0, 5).map((i) => ({
          id: i.id,
          user: i.author?.uniqueId,
          loc: i.locationCreated,
        }))
      );
    }
    const sample = items[0];
    console.log("  item 顶层 keys:", Object.keys(sample).join(", "));
    const itemLoc = Object.entries(sample).filter(([k]) =>
      COUNTRY_KEY_RE.test(k)
    );
    if (itemLoc.length) {
      console.log("  item 地区相关字段:");
      itemLoc.forEach(([k, v]) =>
        console.log(`    ${k} =>`, typeof v === "object" ? JSON.stringify(v).slice(0, 120) : v)
      );
    } else {
      console.log("  item: 无 country/region/location 类顶层字段");
    }
    const author = sample.author || {};
    console.log("  author keys:", Object.keys(author).join(", "));
    const authorLoc = Object.entries(author).filter(([k]) =>
      COUNTRY_KEY_RE.test(k)
    );
    if (authorLoc.length) {
      console.log("  author 地区相关:", Object.fromEntries(authorLoc));
    } else {
      console.log("  author: 无 country/region/location 字段");
    }
    const hits = findCountryLikeFields(sample).filter(
      (h) => !h.path.includes("abTest")
    );
    if (hits.length) {
      console.log("  深层地区字段 (前10):");
      hits.slice(0, 10).forEach((h) => console.log(`    ${h.path} => ${h.value}`));
    }
  };

  if (captured.searchItemFull.length) {
    for (const { url, json } of captured.searchItemFull) {
      const items = json.item_list || json.itemList || [];
      analyzeItems(items, `search/item/full (${items.length})`);
    }
  } else {
    console.log("\n⚠️ 未拦截到 /api/search/item/full/");
    console.log("可能原因: 页面未完全加载搜索结果、网络限制、或需登录后刷新");

    for (const { url, json } of captured.searchOther) {
      const items =
        json.item_list ||
        json.itemList ||
        (Array.isArray(json.data) &&
        json.data[0]?.id
          ? json.data
          : null);
      if (items?.length && items[0]?.author) {
        analyzeItems(items, `fallback: ${url.split("?")[0].slice(-50)}`);
      }
    }
  }

  const pageState = await page.evaluate(() => ({
    title: document.title,
    url: location.href,
    videoCards:
      document.querySelectorAll('[data-e2e="search_video-item"]').length ||
      document.querySelectorAll('[class*="DivItemContainer"]').length,
    locationUi: [...document.querySelectorAll('[data-e2e*="location"], [class*="Location"]')]
      .slice(0, 5)
      .map((el) => ({ e2e: el.getAttribute("data-e2e"), text: el.innerText?.slice(0, 60) })),
  }));
  console.log("\n=== 页面状态 ===");
  console.log(pageState);

  console.log("\n=== 结论 ===");
  if (captured.searchItemFull.length) {
    const items =
      captured.searchItemFull[0].json.item_list ||
      captured.searchItemFull[0].json.itemList ||
      [];
    const withLoc = items.filter((i) => i.locationCreated).length;
    if (withLoc > 0) {
      console.log(
        `搜索 API 含视频级 locationCreated (${withLoc}/${items.length})，可作地区推断；author 对象仍通常无国家字段。`
      );
    } else {
      console.log(
        "搜索 API 已加载，但 item 与 author 均无 locationCreated/country/region 等红人国家字段。"
      );
    }
  } else if (pageState.videoCards > 0) {
    console.log("页面有视频卡片但未拦截 search/item/full，请检查网络或重试。");
  } else {
    console.log("未加载出搜索结果。若未登录请登录后重试。");
  }

  await browser.close();
}

main().catch((e) => {
  console.error("probe failed:", e.message);
  process.exit(1);
});
