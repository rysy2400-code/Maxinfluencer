/**
 * Instagram 关键词搜索页：检查地区字段 + 前 N 条帖子逐条打开统计 location/locationCreated
 * 用法: CDP_ENDPOINT=http://127.0.0.1:9222 node scripts/probe-instagram-search-top-posts-location.js "#aitools" 10
 */
import { chromium } from "playwright";

const COUNTRY_KEY_RE =
  /country|region|location|geo|nation|province|city|locale|locationCreated/i;

function findCountryLikeFields(obj, path = "", out = [], depth = 0) {
  if (depth > 14 || obj == null) return out;
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
          ? JSON.stringify(v).slice(0, 180)
          : String(v).slice(0, 180);
      out.push({ path: p, value: preview });
    }
    if (typeof v === "object" && v !== null) {
      findCountryLikeFields(v, p, out, depth + 1);
    }
  }
  return out;
}

function summarizeMedia(node) {
  if (!node) return null;
  const loc = node.location || node.clips_metadata?.location || null;
  return {
    id: node.pk || node.id || node.code,
    code: node.code,
    mediaType: node.media_type ?? node.product_type,
    locationCreated: node.locationCreated ?? null,
    hasLocationCreated:
      node.locationCreated != null && node.locationCreated !== "",
    location: loc,
    hasLocation: loc != null && typeof loc === "object",
    owner: node.user?.username || node.owner?.username || null,
    ownerCountry: node.user?.country_code || node.owner?.country_code || null,
  };
}

function extractPostsFromJson(json) {
  const posts = [];
  const walk = (obj, depth = 0) => {
    if (depth > 16 || !obj || typeof obj !== "object") return;
    if (Array.isArray(obj)) {
      obj.forEach((x) => walk(x, depth + 1));
      return;
    }
    const hasMedia =
      (obj.code || obj.shortcode) &&
      (obj.pk || obj.id) &&
      (obj.user || obj.owner || obj.caption != null || obj.media_type != null);
    if (hasMedia && (obj.code || obj.shortcode)) {
      posts.push(obj);
    }
    for (const v of Object.values(obj)) {
      if (typeof v === "object" && v) walk(v, depth + 1);
    }
  };
  walk(json);
  const seen = new Set();
  return posts.filter((p) => {
    const key = String(p.pk || p.id || p.code);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function collectSearchPosts(page, keyword, limit) {
  const captured = [];
  const handler = async (response) => {
    const url = response.url();
    if (
      !url.includes("instagram.com") ||
      (!url.includes("/graphql") &&
        !url.includes("/api/") &&
        !url.includes("i.instagram.com"))
    )
      return;
    try {
      const text = await response.text();
      if (!text || (text[0] !== "{" && text[0] !== "[")) return;
      const json = JSON.parse(text);
      const posts = extractPostsFromJson(json);
      if (posts.length) {
        captured.push({ url: url.split("?")[0].slice(-80), posts });
      }
    } catch {
      /* ignore */
    }
  };

  page.on("response", handler);
  const q = keyword.startsWith("#") ? keyword : `#${keyword}`;
  const searchUrl = `https://www.instagram.com/explore/search/keyword/?q=${encodeURIComponent(q)}`;
  console.log(`[probe] 搜索: ${q}`);
  console.log(`[probe] ${searchUrl}\n`);

  const alreadyOnSearch =
    page.url().includes("explore/search/keyword") &&
    decodeURIComponent(page.url()).toLowerCase().includes(q.toLowerCase().replace("#", ""));
  if (!alreadyOnSearch) {
    try {
      await page.goto(searchUrl, {
        waitUntil: "commit",
        timeout: 90000,
      });
    } catch (e) {
      console.warn(`[probe] goto 警告: ${e.message}`);
    }
  } else {
    console.log(`[probe] 复用已打开搜索页: ${page.url()}`);
  }
  await page.waitForTimeout(3000);

  for (let i = 0; i < 8; i++) {
    await page.waitForTimeout(2000);
    await page.evaluate(() => window.scrollBy(0, 600));
  }
  await page.waitForTimeout(3000);
  page.off("response", handler);

  const merged = [];
  const seen = new Set();
  for (const batch of captured) {
    for (const p of batch.posts) {
      const code = p.code || p.shortcode;
      const user = p.user?.username || p.owner?.username;
      if (!code || !user) continue;
      const key = String(p.pk || p.id || code);
      if (seen.has(key)) continue;
      seen.add(key);
      const sum = summarizeMedia(p);
      merged.push({
        ...sum,
        url: `https://www.instagram.com/p/${code}/`,
        searchApiSummary: sum,
        rawSearchLocHits: findCountryLikeFields(p).slice(0, 8),
      });
      if (merged.length >= limit) break;
    }
    if (merged.length >= limit) break;
  }

  if (merged.length < limit) {
    const domLinks = await page.evaluate((lim) => {
      const anchors = [...document.querySelectorAll('a[href*="/p/"], a[href*="/reel/"]')];
      const out = [];
      const seenCodes = new Set();
      for (const a of anchors) {
        const m = a.href.match(/\/(p|reel)\/([A-Za-z0-9_-]+)/);
        if (!m) continue;
        const code = m[2];
        if (seenCodes.has(code)) continue;
        seenCodes.add(code);
        out.push({ code, url: a.href.split("?")[0] });
        if (out.length >= lim) break;
      }
      return out;
    }, limit);
    for (const link of domLinks) {
      const key = link.code;
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push({
        id: null,
        code: link.code,
        url: link.url,
        searchApiSummary: null,
        rawSearchLocHits: [],
      });
      if (merged.length >= limit) break;
    }
  }

  const searchApiHits = [];
  for (const batch of captured) {
    searchApiHits.push(...findCountryLikeFields(batch.posts.slice(0, 3)));
  }

  return { rows: merged, capturedCount: captured.length, searchApiHits };
}

async function probePostDetail(page, row) {
  const detailApis = [];
  const handler = async (response) => {
    const url = response.url();
    if (!url.includes("instagram.com")) return;
    if (
      !url.includes("/graphql") &&
      !url.includes("/api/") &&
      !url.includes("i.instagram.com")
    )
      return;
    try {
      const text = await response.text();
      if (!text || text[0] !== "{") return;
      const json = JSON.parse(text);
      const posts = extractPostsFromJson(json);
      const hit = posts.find(
        (p) => (p.code || p.shortcode) === row.code
      );
      if (hit) {
        detailApis.push({
          url: url.split("?")[0].slice(-70),
          summary: summarizeMedia(hit),
          locHits: findCountryLikeFields(hit).slice(0, 12),
        });
      }
    } catch {
      /* ignore */
    }
  };

  page.on("response", handler);
  try {
    await page.goto(row.url, {
      waitUntil: "commit",
      timeout: 90000,
    });
    await page.waitForTimeout(5000);
    try {
      await page.waitForLoadState("networkidle", { timeout: 8000 });
    } catch {
      /* ok */
    }
    await page.waitForTimeout(2000);
  } finally {
    page.off("response", handler);
  }

  let embedded = { locHits: [], media: null };
  try {
  embedded = await page.evaluate(() => {
    const out = { locHits: [], media: null };
    const scan = (obj, path = "", depth = 0) => {
      if (depth > 14 || !obj || typeof obj !== "object") return;
      if (Array.isArray(obj)) {
        obj.slice(0, 5).forEach((x, i) => scan(x, `${path}[${i}]`, depth + 1));
        return;
      }
      for (const [k, v] of Object.entries(obj)) {
        const p = path ? `${path}.${k}` : k;
        if (
          COUNTRY_KEY_RE.test(k) &&
          v != null &&
          v !== "" &&
          !/excludeByRegion|countryList|cookie/i.test(p)
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
    for (const s of document.querySelectorAll("script")) {
      const t = s.textContent || "";
      if (
        !t.includes("location") &&
        !t.includes("country") &&
        !t.includes("locationCreated")
      )
        continue;
      if (t.length < 50 || t.length > 5_000_000) continue;
      try {
        if (t.trim().startsWith("{")) scan(JSON.parse(t), "script");
      } catch {
        /* ignore */
      }
    }
    return out;
  });
  } catch (e) {
    embedded = { locHits: [], media: null, evaluateError: e.message };
  }

  const bestApi = detailApis.find((a) => a.summary?.code === row.code) || detailApis[0];
  const s = bestApi?.summary;
  const locationCreated =
    s?.locationCreated ??
    row.searchApiSummary?.locationCreated ??
    null;
  const hasLocationCreated =
    locationCreated != null && locationCreated !== "";
  const location = s?.location ?? row.searchApiSummary?.location ?? null;
  const hasLocation = location != null;
  const ownerCountry = s?.ownerCountry ?? row.searchApiSummary?.ownerCountry ?? null;

  return {
    ...row,
    pageUrl: page.url(),
    locationCreated,
    hasLocationCreated,
    location,
    hasLocation,
    ownerCountry,
    detailSource: bestApi
      ? "API"
      : embedded.locHits.length
        ? "DOM_script"
        : null,
    detailApiHits: bestApi?.locHits || [],
    domLocHits: embedded.locHits.slice(0, 10),
    detailApis: detailApis.slice(0, 5),
  };
}

async function main() {
  const keyword = process.argv[2] || "#aitools";
  const limit = Math.min(Math.max(Number(process.argv[3] || 10), 1), 30);
  const endpoint = process.env.CDP_ENDPOINT || "http://127.0.0.1:9222";

  console.log(`[probe] CDP: ${endpoint}`);
  console.log(`[probe] Instagram 关键词搜索 + 前 ${limit} 条详情\n`);

  const browser = await chromium.connectOverCDP(endpoint, { timeout: 15000 });
  const context = browser.contexts()[0] || (await browser.newContext());
  const q = keyword.startsWith("#") ? keyword : `#${keyword}`;
  const searchUrl = `https://www.instagram.com/explore/search/keyword/?q=${encodeURIComponent(q)}`;
  let page = context.pages().find((p) => p.url().includes("explore/search/keyword"));
  if (!page) {
    page = context.pages().find((p) => p.url().includes("instagram.com"));
  }
  if (!page) page = await context.newPage();

  const { rows, capturedCount, searchApiHits } = await collectSearchPosts(
    page,
    keyword,
    limit
  );

  console.log("=== 1) 搜索页 API / 列表是否含红人国家地区 ===");
  console.log(`  拦截含帖子的 API 批次: ${capturedCount}`);
  if (!rows.length) {
    console.error("  ⚠️ 未获取到帖子列表，请确认 9222 Chrome 已登录 Instagram");
    await browser.close();
    process.exit(2);
  }

  const searchWithLocCreated = rows.filter(
    (r) => r.searchApiSummary?.hasLocationCreated
  );
  const searchWithLocation = rows.filter(
    (r) => r.searchApiSummary?.hasLocation
  );
  const searchWithOwnerCountry = rows.filter(
    (r) => r.searchApiSummary?.ownerCountry
  );

  console.log(
    `  搜索列表 locationCreated: ${searchWithLocCreated.length}/${rows.length}`
  );
  console.log(
    `  搜索列表 location(POI):     ${searchWithLocation.length}/${rows.length}`
  );
  console.log(
    `  搜索列表 owner.country_code: ${searchWithOwnerCountry.length}/${rows.length}`
  );
  if (searchApiHits.length) {
    console.log("  搜索 API 深层地区字段样例 (前8):");
    [...new Map(searchApiHits.map((h) => [h.path, h])).values()]
      .slice(0, 8)
      .forEach((h) => console.log(`    ${h.path} => ${h.value}`));
  } else {
    console.log("  搜索 API: 未发现明显 country/region/location 字段");
  }

  console.log(`\n=== 2) 前 ${rows.length} 条逐条打开详情页 ===`);
  const results = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    console.log(`${"─".repeat(60)}`);
    console.log(`[${i + 1}/${rows.length}] ${row.url}`);
    const r = await probePostDetail(page, row);
    results.push(r);
    const lc = r.hasLocationCreated
      ? `locationCreated=${JSON.stringify(r.locationCreated)}`
      : "locationCreated=缺失";
    const loc = r.hasLocation
      ? `location=${JSON.stringify(r.location).slice(0, 80)}`
      : "location=缺失";
    const oc = r.ownerCountry
      ? `owner.country_code=${r.ownerCountry}`
      : "owner.country_code=缺失";
    console.log(`  ${lc} | ${loc} | ${oc} (来源: ${r.detailSource || "无"})`);
  }

  const withLocCreated = results.filter((r) => r.hasLocationCreated);
  const withLocation = results.filter((r) => r.hasLocation);
  const withOwnerCountry = results.filter((r) => r.ownerCountry);
  const codes = {};
  for (const r of withLocCreated) {
    codes[r.locationCreated] = (codes[r.locationCreated] || 0) + 1;
  }

  console.log(`\n${"=".repeat(60)}`);
  console.log("=== 覆盖率汇总 ===");
  console.log(`关键词: ${keyword}`);
  console.log(`样本数: ${results.length}`);
  console.log(
    `搜索列表 locationCreated: ${searchWithLocCreated.length}/${results.length} (${pct(searchWithLocCreated.length, results.length)})`
  );
  console.log(
    `详情页 locationCreated:   ${withLocCreated.length}/${results.length} (${pct(withLocCreated.length, results.length)})`
  );
  console.log(
    `详情页 location(POI):      ${withLocation.length}/${results.length} (${pct(withLocation.length, results.length)})`
  );
  console.log(
    `详情页 owner.country_code: ${withOwnerCountry.length}/${results.length} (${pct(withOwnerCountry.length, results.length)})`
  );
  if (Object.keys(codes).length) {
    console.log("locationCreated 分布:", codes);
  }

  console.log("\n=== 逐条明细 ===");
  for (const r of results) {
    console.log(
      `  ${r.code} | lc=${r.locationCreated ?? "-"} | loc=${r.hasLocation ? "有" : "无"} | owner_cc=${r.ownerCountry ?? "-"}`
    );
  }

  console.log("\n=== 结论 ===");
  if (withLocCreated.length === 0) {
    console.log(
      "Instagram 未使用 TikTok 的 locationCreated 字段；需改用 location(打卡) 或 owner 资料中的 country 等字段。"
    );
  }
  if (withLocation.length === 0 && withOwnerCountry.length === 0) {
    console.log("本批样本在搜索页与详情页均未发现可靠的红人国家/地区字段。");
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
