/**
 * 测试 IG 红人国家/地区 4 种采集方式（9222 CDP，需已登录）
 * 用法: CDP_ENDPOINT=http://127.0.0.1:9222 node scripts/test-ig-country-four-methods.mjs "pool cleaner" 5
 */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import { chromium } from "playwright";
import {
  extractUserNodesFromJson,
  extractMediaNodesFromJson,
  mapIgUserToUserInfo,
} from "../lib/tools/influencer-functions/instagram/instagram-json-utils.js";
import { extractInstagramAboutCountryFromPage } from "../lib/tools/influencer-functions/instagram/extract-instagram-about-country.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
dotenv.config({ path: path.join(root, ".env") });
dotenv.config({ path: path.join(root, ".env.local") });

const keyword = process.argv[2] || "pool cleaner";
const maxUsers = Math.min(Math.max(Number(process.argv[3] || 5), 1), 8);
const endpoint = process.env.CDP_ENDPOINT || "http://127.0.0.1:9222";

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function findCountryCodesInJson(json, username) {
  const codes = [];
  const walk = (obj, path = "", depth = 0) => {
    if (depth > 20 || !obj || typeof obj !== "object") return;
    if (Array.isArray(obj)) {
      obj.forEach((x, i) => walk(x, `${path}[${i}]`, depth + 1));
      return;
    }
    for (const [k, v] of Object.entries(obj)) {
      const p = path ? `${path}.${k}` : k;
      if (
        (k === "country_code" || k === "countryCode") &&
        v != null &&
        v !== ""
      ) {
        codes.push({ path: p, value: v });
      }
      if (typeof v === "object" && v) walk(v, p, depth + 1);
    }
  };
  walk(json);
  const user = extractUserNodesFromJson(json, username);
  return { codes, user };
}

function summarizePostLocation(node) {
  if (!node) return null;
  const loc = node.location || node.clips_metadata?.location || null;
  return {
    locationCreated: node.locationCreated ?? null,
    location: loc,
    ownerCountry:
      node.user?.country_code || node.owner?.country_code || null,
  };
}

async function collectUsernamesFromSearch(page, kw, limit) {
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
      captured.push(JSON.parse(text));
    } catch {
      /* ignore */
    }
  };
  page.on("response", handler);
  const q = kw.startsWith("#") ? kw : kw;
  const searchUrl = `https://www.instagram.com/explore/search/keyword/?q=${encodeURIComponent(q)}`;
  await page.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
  for (let i = 0; i < 6; i++) {
    await sleep(2000);
    await page.evaluate(() => window.scrollBy(0, 500));
  }
  await sleep(2000);
  page.off("response", handler);

  const seen = new Set();
  const users = [];
  for (const json of captured) {
    for (const p of extractMediaNodesFromJson(json)) {
      const u = (p.user?.username || p.owner?.username || "").replace(/^@/, "");
      if (!u || seen.has(u)) continue;
      seen.add(u);
      users.push(u);
      if (users.length >= limit) return users;
    }
  }
  return users;
}

/** 方法1：账户简介 / 关于此账户 + wbloks + DOM */
async function testMethod1AboutAccount(page, username) {
  const r = await extractInstagramAboutCountryFromPage(page, username, {
    waitAfterAboutMs: 12_000,
  });
  return {
    ok: r.success,
    country: r.accountCountry,
    source: r.source,
    wbloksCountry: r.wbloksCountry,
    domCountry: r.domCountry,
    wbloksRequests: r.wbloksRequests,
    menuOpened: r.menuResult?.ok ?? false,
    aboutClick: r.aboutClick,
    clickError: r.error,
    hasAboutDialog: r.hasAboutDialog,
  };
}

/** 方法2：GraphQL country_code */
async function testMethod2CountryCode(page, username) {
  const allCodes = [];
  let userInfo = null;
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
      const { codes, user } = findCountryCodesInJson(json, username);
      if (codes.length) allCodes.push(...codes);
      if (user) {
        userInfo = mapIgUserToUserInfo(user);
        if (user.country_code) {
          allCodes.push({
            path: "user.country_code",
            value: user.country_code,
          });
        }
      }
    } catch {
      /* ignore */
    }
  };

  page.on("response", handler);
  try {
    await page.goto(`https://www.instagram.com/${username}/`, {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    });
    await sleep(3000);
    await page.goto(`https://www.instagram.com/${username}/reels/`, {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    });
    await sleep(3000);
    for (let i = 0; i < 3; i++) {
      await page.evaluate(() => window.scrollBy(0, 800));
      await sleep(1500);
    }
  } finally {
    page.off("response", handler);
  }

  const unique = [...new Map(allCodes.map((c) => [`${c.path}:${c.value}`, c])).values()];
  return {
    ok: unique.length > 0,
    countryCodes: unique.slice(0, 8),
    bio: userInfo?.bio?.slice(0, 120) || null,
    followers: userInfo?.followers?.display || null,
  };
}

/** 方法3：帖子/Reels location */
async function testMethod3ContentLocation(page, username) {
  const locs = [];
  const handler = async (response) => {
    const url = response.url();
    if (
      !url.includes("instagram.com") ||
      (!url.includes("/graphql") && !url.includes("/api/"))
    )
      return;
    try {
      const text = await response.text();
      if (!text || text[0] !== "{") return;
      const json = JSON.parse(text);
      for (const p of extractMediaNodesFromJson(json)) {
        const u = p.user?.username || p.owner?.username;
        if (u && u.toLowerCase() !== username.toLowerCase()) continue;
        const s = summarizePostLocation(p);
        if (s.location || s.locationCreated || s.ownerCountry) {
          locs.push(s);
        }
      }
    } catch {
      /* ignore */
    }
  };

  page.on("response", handler);
  let navError = null;
  try {
    try {
      await page.goto(`https://www.instagram.com/${username}/reels/`, {
        waitUntil: "commit",
        timeout: 90000,
      });
    } catch (e) {
      navError = e.message;
      try {
        await page.goto(`https://www.instagram.com/${username}/`, {
          waitUntil: "commit",
          timeout: 90000,
        });
      } catch (e2) {
        navError = e2.message;
      }
    }
    await sleep(2500);
    for (let i = 0; i < 5; i++) {
      await page.evaluate(() => window.scrollBy(0, 900));
      await sleep(1800);
    }
    await sleep(2000);
  } finally {
    page.off("response", handler);
  }

  const withPoi = locs.filter((l) => l.location);
  const withLc = locs.filter((l) => l.locationCreated);
  const withOwner = locs.filter((l) => l.ownerCountry);
  return {
    ok: withPoi.length > 0 || withLc.length > 0 || withOwner.length > 0,
    totalMediaHits: locs.length,
    withLocationPoi: withPoi.length,
    withLocationCreated: withLc.length,
    withOwnerCountry: withOwner.length,
    samples: locs.slice(0, 3),
    navError,
  };
}

/** 方法4：Bio + caption LLM */
async function testMethod4LlmInfer(userInfo, captions) {
  const hasKey = !!process.env.DEEPSEEK_API_KEY;
  if (!hasKey) {
    return {
      ok: false,
      skipped: true,
      reason: "DEEPSEEK_API_KEY 未配置",
    };
  }

  const { callDeepSeekLLM } = await import("../lib/utils/llm-client.js");
  const bio = userInfo?.bio || "(无简介)";
  const caps = (captions || []).slice(0, 5).join("\n---\n") || "(无 caption)";

  const prompt = `根据以下 Instagram 红人资料，推断其最可能的主要国家/地区（ISO 3166-1 alpha-2 或常见英文名）。
只输出 JSON：{"country":"US","confidence":"high|medium|low","reason":"一句话"}
bio:
${bio}
近期 caption:
${caps}`;

  try {
    const raw = await callDeepSeekLLM(
      [{ role: "user", content: prompt }],
      "你是社媒地理推断助手，仅返回合法 JSON。",
      { maxTokens: 256, timeoutMs: 45000 }
    );
    const m = raw.match(/\{[\s\S]*\}/);
    const parsed = m ? JSON.parse(m[0]) : null;
    return {
      ok: !!parsed?.country,
      inferred: parsed,
      method: "llm_inferred",
    };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function collectCaptions(page, username) {
  const caps = [];
  const handler = async (response) => {
    const url = response.url();
    if (!url.includes("instagram.com")) return;
    try {
      const text = await response.text();
      if (!text || text[0] !== "{") return;
      const json = JSON.parse(text);
      for (const p of extractMediaNodesFromJson(json)) {
        const cap =
          p.caption?.text ||
          (typeof p.caption === "string" ? p.caption : null) ||
          p.edge_media_to_caption?.edges?.[0]?.node?.text;
        if (cap && cap.length > 3) caps.push(String(cap).slice(0, 300));
      }
    } catch {
      /* ignore */
    }
  };
  page.on("response", handler);
  await page.goto(`https://www.instagram.com/${username}/reels/`, {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });
  await sleep(3000);
  for (let i = 0; i < 4; i++) {
    await page.evaluate(() => window.scrollBy(0, 700));
    await sleep(1500);
  }
  page.off("response", handler);
  return [...new Set(caps)].slice(0, 8);
}

async function main() {
  console.log(`\n${"=".repeat(70)}`);
  console.log("IG 国家/地区 四方式测试");
  console.log(`CDP: ${endpoint}`);
  console.log(`关键词: ${keyword} | 红人数: ${maxUsers}\n`);

  const browser = await chromium.connectOverCDP(endpoint, { timeout: 15000 });
  const context = browser.contexts()[0] || (await browser.newContext());
  let page =
    context.pages().find((p) => p.url().includes("instagram.com")) ||
    (await context.newPage());

  console.log("[准备] 从关键词搜索采集用户名...");
  const usernames = await collectUsernamesFromSearch(page, keyword, maxUsers);
  if (!usernames.length) {
    console.error("❌ 未获取到红人用户名，请确认 9222 已登录 Instagram");
    await browser.close();
    process.exit(2);
  }
  console.log(`[准备] 样本: ${usernames.map((u) => `@${u}`).join(", ")}\n`);

  const summary = {
    method1: { hit: 0, total: 0 },
    method2: { hit: 0, total: 0 },
    method3: { hit: 0, total: 0 },
    method4: { hit: 0, total: 0, skipped: false },
  };
  const details = [];

  for (const username of usernames) {
    console.log(`${"─".repeat(70)}`);
    console.log(`@${username}`);

    let m2;
    try {
      m2 = await testMethod2CountryCode(page, username);
    } catch (e) {
      m2 = {
        ok: false,
        countryCodes: [],
        bio: null,
        followers: null,
        error: e.message,
      };
    }
    summary.method2.total += 1;
    if (m2.ok) summary.method2.hit += 1;
    console.log(
      `  [2] GraphQL country_code: ${m2.ok ? "✅" : "❌"} ${m2.countryCodes?.map((c) => `${c.path}=${c.value}`).join("; ") || "无"}`
    );

    let m3;
    try {
      m3 = await testMethod3ContentLocation(page, username);
    } catch (e) {
      m3 = {
        ok: false,
        totalMediaHits: 0,
        withLocationPoi: 0,
        withLocationCreated: 0,
        withOwnerCountry: 0,
        samples: [],
        navError: e.message,
      };
    }
    summary.method3.total += 1;
    if (m3.ok) summary.method3.hit += 1;
    console.log(
      `  [3] 内容 location: ${m3.ok ? "✅" : "❌"} POI=${m3.withLocationPoi} lc=${m3.withLocationCreated} owner_cc=${m3.withOwnerCountry} (媒体命中 ${m3.totalMediaHits})${m3.navError ? ` nav=${m3.navError}` : ""}`
    );

    let captions = [];
    try {
      captions = await collectCaptions(page, username);
    } catch (e) {
      console.log(`  [4] caption 采集失败: ${e.message}`);
    }
    const m4 = await testMethod4LlmInfer(
      { bio: m2.bio },
      captions
    );
    summary.method4.total += 1;
    if (m4.skipped) summary.method4.skipped = true;
    if (m4.ok) summary.method4.hit += 1;
    console.log(
      `  [4] LLM 推断: ${m4.skipped ? "⏭ 跳过" : m4.ok ? "✅" : "❌"} ${m4.inferred ? JSON.stringify(m4.inferred) : m4.error || m4.reason || ""}`
    );

    let m1;
    try {
      m1 = await testMethod1AboutAccount(page, username);
    } catch (e) {
      m1 = {
        ok: false,
        country: null,
        wbloksRequests: 0,
        menuOpened: false,
        clickError: e.message,
        samples: [],
      };
    }
    summary.method1.total += 1;
    if (m1.ok) summary.method1.hit += 1;
    console.log(
      `  [1] 账户简介: ${m1.ok ? "✅" : "❌"} country=${m1.country ?? "无"} src=${m1.source ?? "-"} about=${m1.aboutClick?.label ?? "-"} wbloks=${m1.wbloksRequests}${m1.clickError ? ` err=${m1.clickError}` : ""}`
    );

    details.push({ username, m1, m2, m3, m4 });
    await sleep(2000);
  }

  console.log(`\n${"=".repeat(70)}`);
  console.log("=== 汇总（覆盖率 = 命中数 / 样本数）===");
  console.log(
    `  [1] 关于此账户 wbloks:     ${summary.method1.hit}/${summary.method1.total} (${pct(summary.method1.hit, summary.method1.total)})`
  );
  console.log(
    `  [2] GraphQL country_code:  ${summary.method2.hit}/${summary.method2.total} (${pct(summary.method2.hit, summary.method2.total)})`
  );
  console.log(
    `  [3] 内容 location/打卡:    ${summary.method3.hit}/${summary.method3.total} (${pct(summary.method3.hit, summary.method3.total)})`
  );
  console.log(
    `  [4] Bio+caption LLM:       ${summary.method4.skipped ? "未测(API Key)" : `${summary.method4.hit}/${summary.method4.total} (${pct(summary.method4.hit, summary.method4.total)})`}`
  );

  console.log("\n=== 结论建议 ===");
  if (summary.method1.hit > 0) {
    console.log("  • 方式1可用：建议在 enrich 流程中自动化打开「关于此账户」并拦 wbloks。");
  } else {
    console.log("  • 方式1本批未命中：可能菜单未点开、账号无 About、或需更长等待/不同 selector。");
  }
  if (summary.method2.hit > 0) {
    console.log("  • 方式2可作补充：profile/reels GraphQL 偶发含 country_code。");
  } else {
    console.log("  • 方式2本批无 country_code：不宜作唯一来源。");
  }
  if (summary.method3.hit > 0) {
    console.log("  • 方式3有打卡/POI：适合内容地理，不等于注册国。");
  } else {
    console.log("  • 方式3本批无 location：红人未打卡或 API 未返回。");
  }
  if (!summary.method4.skipped) {
    console.log(
      summary.method4.hit > 0
        ? "  • 方式4 LLM 可兜底，结果应标 inferred。"
        : "  • 方式4 LLM 本批未给出有效国家。"
    );
  }

  await browser.close();
  process.exit(0);
}

function pct(n, t) {
  if (!t) return "0%";
  return `${((100 * n) / t).toFixed(0)}%`;
}

main().catch((e) => {
  console.error("test failed:", e);
  process.exit(1);
});
