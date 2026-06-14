/**
 * 探测 Instagram 关键词搜索：UI 是否 No results vs API 拦截到的创作者名单
 * 用法: CDP_ENDPOINT=http://127.0.0.1:9222 node scripts/probe-ig-no-result-creators.mjs
 * 或指定关键词: node scripts/probe-ig-no-result-creators.mjs "keyword1" "keyword2"
 */
import { chromium } from "playwright";
import { extractMediaNodesFromJson } from "../lib/tools/influencer-functions/instagram/instagram-json-utils.js";

const DEFAULT_KEYWORDS = [
  "pet transformation video effect instagram",
  "xyznonexistentkeyword999888777",
  "pool robot cleaner demo",
  "ai pet filter reel",
  "zzzzzzzzzzzzzzzzzzzzzzzzzzzz",
];

function isInstagramApiUrl(url) {
  return (
    url.includes("instagram.com") &&
    (url.includes("/graphql") ||
      url.includes("/api/") ||
      url.includes("i.instagram.com"))
  );
}

async function detectUiNoResults(page) {
  return page.evaluate(() => {
    const bodyText = (document.body?.innerText || "").toLowerCase();
    const noResultPhrases = [
      "no results",
      "couldn't find anything",
      "couldn't find anything for that search",
      "we couldn't find anything",
    ];
    const phraseHit = noResultPhrases.some((p) => bodyText.includes(p));

    const postLinks = [
      ...document.querySelectorAll('a[href*="/p/"], a[href*="/reel/"]'),
    ].filter((a) => {
      const href = a.getAttribute("href") || "";
      return /\/(p|reel)\/[A-Za-z0-9_-]+/.test(href);
    });

    const userLinks = [
      ...document.querySelectorAll('a[href^="/"][href*="/"]'),
    ].filter((a) => {
      const href = a.getAttribute("href") || "";
      return /^\/[A-Za-z0-9._]+\/$/.test(href) && !href.startsWith("/explore");
    });

    return {
      phraseHit,
      bodySnippet: bodyText.slice(0, 400).replace(/\s+/g, " "),
      visiblePostLinkCount: postLinks.length,
      visibleUserLinkCount: userLinks.length,
      url: location.href,
    };
  });
}

async function probeKeyword(page, keyword, scrollRounds = 4) {
  const captured = [];
  const apiUrls = [];

  const handler = async (response) => {
    const url = response.url();
    if (!isInstagramApiUrl(url)) return;
    try {
      const text = await response.text();
      if (!text || (text[0] !== "{" && text[0] !== "[")) return;
      const json = JSON.parse(text);
      const posts = extractMediaNodesFromJson(json);
      if (posts.length) {
        captured.push({
          apiPath: url.split("?")[0].replace(/^https?:\/\/[^/]+/, ""),
          posts,
        });
        apiUrls.push(url.split("?")[0].replace(/^https?:\/\/[^/]+/, ""));
      }
    } catch {
      /* ignore */
    }
  };

  const searchUrl = `https://www.instagram.com/explore/search/keyword/?q=${encodeURIComponent(keyword)}`;
  page.on("response", handler);

  try {
    await page.bringToFront();
  } catch {
    /* ignore */
  }

  try {
    await page.goto(searchUrl, { waitUntil: "commit", timeout: 60000 });
  } catch (e) {
    console.warn(`  goto 警告: ${e.message}`);
  }

  await page.waitForTimeout(3000);

  for (let i = 0; i < scrollRounds; i++) {
    await page.waitForTimeout(1500);
    await page.evaluate(() => window.scrollBy(0, 600));
  }
  await page.waitForTimeout(2000);

  page.off("response", handler);

  const ui = await detectUiNoResults(page);

  const postsByUser = new Map();
  const postsFlat = [];

  for (const batch of captured) {
    for (const raw of batch.posts) {
      const username = raw.user?.username || raw.owner?.username;
      const code = raw.code || raw.shortcode;
      if (!username || !code) continue;
      postsFlat.push({
        username,
        postCode: code,
        caption: (
          typeof raw.caption === "string"
            ? raw.caption
            : raw.caption?.text || ""
        ).slice(0, 120),
        apiPath: batch.apiPath,
      });
      const u = username.replace(/^@/, "");
      if (!postsByUser.has(u)) {
        postsByUser.set(u, {
          username: u,
          profileUrl: `https://www.instagram.com/${u}/`,
          posts: [],
          apiPaths: new Set(),
        });
      }
      const rec = postsByUser.get(u);
      rec.posts.push({ postCode: code, caption: postsFlat.at(-1).caption });
      rec.apiPaths.add(batch.apiPath);
    }
  }

  const creators = [...postsByUser.values()].map((c) => ({
    username: c.username,
    profileUrl: c.profileUrl,
    postCount: c.posts.length,
    sampleCaptions: c.posts.slice(0, 2).map((p) => p.caption).filter(Boolean),
    apiPaths: [...c.apiPaths],
  }));

  const uniqueApiPaths = [...new Set(apiUrls)];

  return {
    keyword,
    searchUrl,
    uiNoResults: ui.phraseHit && ui.visiblePostLinkCount === 0,
    ui,
    capturedBatches: captured.length,
    totalPostsIntercepted: postsFlat.length,
    creatorCount: creators.length,
    creators,
    apiPaths: uniqueApiPaths.slice(0, 15),
    postsFlat: postsFlat.slice(0, 20),
  };
}

async function main() {
  const keywords =
    process.argv.length > 2 ? process.argv.slice(2) : DEFAULT_KEYWORDS;
  const endpoint = process.env.CDP_ENDPOINT || "http://127.0.0.1:9222";

  console.log(`[probe-no-result] CDP: ${endpoint}`);
  console.log(`[probe-no-result] 关键词数: ${keywords.length}\n`);

  let browser;
  try {
    browser = await chromium.connectOverCDP(endpoint, { timeout: 15000 });
  } catch (e) {
    console.error(`无法连接 CDP (${endpoint}): ${e.message}`);
    console.error("请确保 9222 Chrome 已启动且已登录 Instagram");
    process.exit(2);
  }

  const context = browser.contexts()[0] || (await browser.newContext());
  let page = context.pages().find((p) => p.url().includes("instagram.com"));
  if (!page) page = await context.newPage();

  const results = [];
  for (const kw of keywords) {
    console.log(`${"=".repeat(70)}`);
    console.log(`关键词: "${kw}"`);
    const r = await probeKeyword(page, kw);
    results.push(r);

    console.log(`  UI No results: ${r.uiNoResults ? "是" : "否"}`);
    console.log(`  UI 可见帖子链接: ${r.ui.visiblePostLinkCount}`);
    console.log(`  API 拦截批次: ${r.capturedBatches}`);
    console.log(`  API 拦截帖子数: ${r.totalPostsIntercepted}`);
    console.log(`  解析出创作者数: ${r.creatorCount}`);

    if (r.uiNoResults && r.creatorCount > 0) {
      console.log(`  ⚠️  UI 无结果但 API 仍抓到 ${r.creatorCount} 位创作者`);
    } else if (!r.uiNoResults && r.creatorCount === 0) {
      console.log(`  ⚠️  UI 可能有结果但 API 未拦截到帖子`);
    }

    if (r.apiPaths.length) {
      console.log(`  涉及 API 路径 (前5):`);
      r.apiPaths.slice(0, 5).forEach((p) => console.log(`    ${p}`));
    }

    if (r.creators.length) {
      console.log(`  完整创作者名单 (${r.creators.length}):`);
      for (const c of r.creators) {
        const caps = c.sampleCaptions.length
          ? ` | 样例caption: ${c.sampleCaptions.join(" / ").slice(0, 100)}`
          : "";
        console.log(`    @${c.username} (${c.postCount}帖)${caps}`);
      }
    } else {
      console.log(`  创作者名单: (空)`);
    }
    console.log("");
  }

  console.log(`${"=".repeat(70)}`);
  console.log("汇总");
  for (const r of results) {
    const flag =
      r.uiNoResults && r.creatorCount > 0
        ? "UI无结果+API有创作者"
        : r.uiNoResults
          ? "UI无结果+API空"
          : r.creatorCount > 0
            ? "UI有结果+API有创作者"
            : "UI/API均空";
    console.log(
      `  [${flag}] "${r.keyword}" → ${r.creatorCount} 创作者, ${r.totalPostsIntercepted} 帖`
    );
  }

  try {
    await browser.disconnect();
  } catch {
    /* ignore */
  }
}

main().catch((e) => {
  console.error("probe failed:", e.message);
  process.exit(1);
});
