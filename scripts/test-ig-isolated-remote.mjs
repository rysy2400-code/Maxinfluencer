#!/usr/bin/env node
/**
 * 临时停 worker → 重启 Chrome 到 IG 首页 → 跑 probe → 可选恢复 worker
 */
import { spawnSync } from "child_process";
import { chromium } from "playwright";
import {
  acquireInstagramApiSession,
  fetchKeywordSearchPage,
  fetchWebProfileInfo,
  fetchUserClipsPage,
  extractIgRelayBootstrap,
  igGraphqlFetch,
} from "../lib/tools/influencer-functions/instagram/instagram-direct-fetch.js";
import { extractMediaNodesFromJson } from "../lib/tools/influencer-functions/instagram/instagram-json-utils.js";

const keyword = process.argv[2] || "pool cleaner";
const username = process.argv[3] || "natgeo";
const CDP = process.env.CDP_ENDPOINT || "http://127.0.0.1:9222";
const isWin = process.platform === "win32";

function ps(cmd) {
  if (!isWin) return { ok: false, out: "not windows" };
  const r = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-Command", cmd],
    { encoding: "utf8", timeout: 120_000 }
  );
  return { ok: r.status === 0, out: (r.stdout || "") + (r.stderr || "") };
}

async function waitCdp(maxSec = 30) {
  for (let i = 0; i < maxSec; i++) {
    try {
      const r = await fetch(`${CDP}/json/version`);
      if (r.ok) return true;
    } catch {
      /* retry */
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

console.log("[ig-isolated-test] stopping worker...");
ps(
  "Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -match 'worker-influencer-search' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"
);

console.log("[ig-isolated-test] restarting chrome to instagram home...");
ps(
  "$chrome='C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'; $dir='C:\\maxinfluencer\\.chrome-cdp-9222'; Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and ($_.CommandLine -match [regex]::Escape($dir)) } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }; Start-Sleep 2; Start-Process -FilePath $chrome -ArgumentList @('--remote-debugging-address=127.0.0.1','--remote-debugging-port=9222',\"--user-data-dir=$dir\",'--no-first-run','--no-default-browser-check','--disable-gpu','https://www.instagram.com/')"
);

if (!(await waitCdp())) {
  console.error("[ig-isolated-test] CDP not ready");
  process.exit(2);
}
await new Promise((r) => setTimeout(r, 8000));

const list = await (await fetch(`${CDP}/json/list`)).json();
console.log(
  "[ig-isolated-test] CDP tabs:",
  list.filter((t) => t.type === "page").map((t) => t.url).join(" | ")
);

const browser = await chromium.connectOverCDP(CDP, { timeout: 15000 });
const context = browser.contexts()[0];
const session = await acquireInstagramApiSession(context);
const { page } = session;

const boot = await extractIgRelayBootstrap(page);
console.log("[ig-isolated-test] bootstrap:", JSON.stringify(boot, null, 2));

const profileJson = await fetchWebProfileInfo(page, username);
const userId = profileJson?.data?.user?.id || profileJson?.data?.user?.pk || null;

const searchJson = await fetchKeywordSearchPage(page, keyword);
const searchPosts = searchJson ? extractMediaNodesFromJson(searchJson).length : 0;

let clipsCount = 0;
if (userId) {
  const clipsJson = await fetchUserClipsPage(page, userId, { username });
  clipsCount = clipsJson ? extractMediaNodesFromJson(clipsJson).length : 0;
}

console.log(
  JSON.stringify(
    {
      pageUrl: page.url(),
      profile: { ok: !!profileJson, userId, username: profileJson?.data?.user?.username },
      search: { ok: !!searchJson, posts: searchPosts, preview: searchJson ? JSON.stringify(searchJson).slice(0, 200) : null },
      clips: { ok: clipsCount > 0, reels: clipsCount },
    },
    null,
    2
  )
);

await session.dispose();
await browser.close().catch(() => {});

console.log("[ig-isolated-test] restarting worker...");
ps(
  "Set-Location C:\\maxinfluencer; Start-Process -FilePath node -ArgumentList @('--experimental-default-type=module','scripts/worker-influencer-search.js') -WindowStyle Hidden"
);
