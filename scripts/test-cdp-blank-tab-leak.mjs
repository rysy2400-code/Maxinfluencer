/**
 * 验证 9222 CDP 搜索后 about:blank 标签不会持续堆积
 * 用法: CDP_ENDPOINT=http://127.0.0.1:9222 node scripts/test-cdp-blank-tab-leak.mjs
 */
import { chromium } from "playwright";

const { searchInstagramByKeyword } = await import(
  "../lib/tools/influencer-functions/instagram/search-instagram-by-keyword.js"
);
const { searchYoutubeByKeyword } = await import(
  "../lib/tools/influencer-functions/youtube/search-youtube-by-keyword.js"
);

const endpoint = process.env.CDP_ENDPOINT || "http://127.0.0.1:9222";

async function countBlankTabs(browser) {
  const pages = browser.contexts().flatMap((c) => c.pages()).filter((p) => !p.isClosed());
  let blank = 0;
  for (const p of pages) {
    try {
      const u = p.url();
      if (!u || u === "about:blank" || u.startsWith("chrome://newtab")) blank += 1;
    } catch {
      blank += 1;
    }
  }
  return { total: pages.length, blank };
}

async function runPlatformSearch(name, fn) {
  const before = await countBlankTabs(globalBrowser);
  console.log(`[test] ${name} BEFORE total=${before.total} blank=${before.blank}`);
  try {
    await fn();
    console.log(`[test] ${name} search OK`);
  } catch (e) {
    console.warn(`[test] ${name} search failed (still check tab leak): ${e.message}`);
  }
  await new Promise((r) => setTimeout(r, 2000));
  const after = await countBlankTabs(globalBrowser);
  console.log(`[test] ${name} AFTER  total=${after.total} blank=${after.blank}`);
  const blankDelta = after.blank - before.blank;
  return { name, before, after, blankDelta, ok: blankDelta <= 0 };
}

let globalBrowser = null;

async function main() {
  try {
    globalBrowser = await chromium.connectOverCDP(endpoint, { timeout: 15000 });
  } catch (e) {
    console.error(`[test] CDP connect failed: ${e.message}`);
    process.exit(2);
  }

  const initial = await countBlankTabs(globalBrowser);
  console.log(`[test] INITIAL total=${initial.total} blank=${initial.blank}`);

  const results = [];

  results.push(
    await runPlatformSearch("instagram", () =>
      searchInstagramByKeyword(
        { keywords: { search_queries: ["pool cleaner test"] } },
        { searchOptions: { maxInfluencers: 3, scrollRounds: 2 } }
      )
    )
  );

  results.push(
    await runPlatformSearch("youtube", () =>
      searchYoutubeByKeyword(
        { keywords: { search_queries: ["AI agent demo test"] } },
        { searchOptions: { maxChannels: 3, scrollRounds: 3 } }
      )
    )
  );

  const final = await countBlankTabs(globalBrowser);
  console.log(`[test] FINAL   total=${final.total} blank=${final.blank}`);

  await globalBrowser.close().catch(() => {});

  const failed = results.filter((r) => !r.ok);
  const pass = failed.length === 0 && final.blank <= initial.blank + 1;

  console.log(
    JSON.stringify(
      {
        pass,
        initial,
        final,
        platforms: results,
        note: pass
          ? "blank tabs did not accumulate per platform run"
          : "blank tab count increased — leak may remain",
      },
      null,
      2
    )
  );

  process.exit(pass ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
