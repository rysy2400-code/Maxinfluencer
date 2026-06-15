/**
 * 9222 CDP 自动化标签页清理：避免 about:blank 无限堆积。
 * Lite + IG/YT 共用 9222 时对齐各 1 个平台首页常驻 tab。
 */
import { openCdpContextPage } from "./open-cdp-page.js";
import { isLiteScraperMode } from "../scraper/resolve-scraper-mode.js";

const PLATFORM_HOME_URL = {
  instagram: "https://www.instagram.com/",
  youtube: "https://www.youtube.com/",
};

/**
 * @param {string} [url]
 */
function normalizeTabUrl(url) {
  return String(url || "")
    .split("?")[0]
    .split("#")[0]
    .replace(/\/+$/, "");
}

/**
 * @param {string} [url]
 */
export function isInstagramPlatformUrl(url) {
  return String(url || "").includes("instagram.com");
}

/**
 * @param {string} [url]
 */
export function isYoutubePlatformUrl(url) {
  return String(url || "").includes("youtube.com");
}

/**
 * @param {string} [url]
 */
export function isInstagramHomeUrl(url) {
  const u = normalizeTabUrl(url);
  return u === "https://www.instagram.com" || u.endsWith("instagram.com");
}

/**
 * @param {string} [url]
 */
export function isYoutubeHomeUrl(url) {
  const u = normalizeTabUrl(url);
  return u === "https://www.youtube.com" || u === "https://m.youtube.com";
}

/**
 * Lite 9222 需常驻的平台列表（instagram / youtube）
 * @param {{ platform?: string, persistentPlatforms?: string[] }} [meta]
 * @returns {Array<'instagram'|'youtube'>}
 */
export function resolvePersistent9222Platforms(meta = {}) {
  if (Array.isArray(meta.persistentPlatforms) && meta.persistentPlatforms.length) {
    return [...new Set(meta.persistentPlatforms.filter((p) => p === "instagram" || p === "youtube"))];
  }
  const raw =
    process.env.CDP_9222_PERSISTENT_PLATFORMS ||
    process.env.SEARCH_WORKER_PLATFORMS ||
    "";
  const fromEnv = raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((p) => p === "instagram" || p === "youtube");
  if (fromEnv.length) return [...new Set(fromEnv)];
  const slug = String(meta.platform || "").toLowerCase();
  if (slug === "instagram" || slug === "youtube") return [slug];
  return [];
}

/**
 * @param {{ platform?: string, persistentPlatforms?: string[], alignPersistentTabs?: boolean, liteMode?: boolean }} [meta]
 */
export function shouldAlignPersistent9222Tabs(meta = {}) {
  if (meta.alignPersistentTabs === false) return false;
  if (!isLiteScraperMode() && meta.liteMode !== true) return false;
  const platforms = resolvePersistent9222Platforms(meta);
  return platforms.includes("instagram") || platforms.includes("youtube");
}

/**
 * @param {import('playwright').Page} page
 */
function pageUrlSafe(page) {
  try {
    return page.url() || "";
  } catch {
    return "";
  }
}

/**
 * @param {import('playwright').Page} page
 * @param {'instagram'|'youtube'} platform
 */
function rankPlatformPage(page, platform) {
  const url = pageUrlSafe(page);
  if (platform === "instagram") {
    if (isInstagramHomeUrl(url)) return 0;
    if (isInstagramPlatformUrl(url)) return 1;
    return 9;
  }
  if (isYoutubeHomeUrl(url)) return 0;
  if (isYoutubePlatformUrl(url)) return 1;
  return 9;
}

/**
 * @param {import('playwright').BrowserContext} context
 */
async function listLiveContextPages(context) {
  for (let attempt = 0; attempt < 12; attempt++) {
    const pages = context.pages().filter((p) => {
      try {
        return p && !p.isClosed();
      } catch {
        return false;
      }
    });
    if (pages.length) return pages;
    await new Promise((r) => setTimeout(r, 400));
  }
  return [];
}

function cdp9222Endpoint() {
  return process.env.CDP_ENDPOINT || "http://127.0.0.1:9222";
}

/**
 * @param {import('playwright').BrowserContext} context
 * @param {'instagram'|'youtube'} platform
 */
async function openPlatformHomeTab(context, platform) {
  const homeUrl = PLATFORM_HOME_URL[platform];
  const isMatch = (url) =>
    platform === "instagram" ? isInstagramPlatformUrl(url) : isYoutubePlatformUrl(url);

  const findInContext = () =>
    context.pages().find((p) => {
      try {
        return p && !p.isClosed() && isMatch(pageUrlSafe(p));
      } catch {
        return false;
      }
    });

  let page = findInContext();
  if (page) {
    await navigatePlatformPageHome(page, platform);
    return page;
  }

  const livePages = await listLiveContextPages(context);
  const blank =
    livePages.find((p) => isDisposableCdpTabUrl(pageUrlSafe(p))) ||
    (livePages.length === 1 ? livePages[0] : null);
  if (blank) {
    try {
      await blank.goto(homeUrl, { waitUntil: "domcontentloaded", timeout: 45_000 });
      return blank;
    } catch (e) {
      console.warn(`[cdp-align] reuse tab for ${platform} failed: ${e?.message || e}`);
    }
  }

  const endpoint = cdp9222Endpoint();
  try {
    const { openCdpTab } = await import("./cdp-target-page.js");
    await openCdpTab(endpoint, homeUrl);
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 400));
      page = findInContext();
      if (page) {
        await navigatePlatformPageHome(page, platform);
        return page;
      }
    }
  } catch (e) {
    console.warn(`[cdp-align] CDP /json/new for ${platform} failed: ${e?.message || e}`);
  }

  page = await openCdpTaskPage(context);
  try {
    await page.goto(homeUrl, { waitUntil: "domcontentloaded", timeout: 45_000 });
  } catch (e) {
    console.warn(`[cdp-align] ${platform} home goto failed: ${e?.message || e}`);
  }
  return page;
}

/**
 * @param {import('playwright').Page} page
 * @param {'instagram'|'youtube'} platform
 */
async function navigatePlatformPageHome(page, platform) {
  const homeUrl = PLATFORM_HOME_URL[platform];
  const url = pageUrlSafe(page);
  if (platform === "instagram" && isInstagramHomeUrl(url)) return;
  if (platform === "youtube" && isYoutubeHomeUrl(url)) return;
  if (!url.includes(platform === "instagram" ? "instagram.com" : "youtube.com")) {
    try {
      await page.goto(homeUrl, { waitUntil: "domcontentloaded", timeout: 45_000 });
    } catch (e) {
      console.warn(`[cdp-align] navigate ${platform} home failed: ${e?.message || e}`);
    }
    return;
  }
  try {
    await page.goto(homeUrl, { waitUntil: "domcontentloaded", timeout: 45_000 });
  } catch {
    /* 子路径回首页失败不阻断 */
  }
}

/**
 * Lite IG/YT：任务前对齐 9222 — 各保留 1 个平台首页，关闭多余/临时 tab
 * @param {import('playwright').BrowserContext} context
 * @param {{ logPrefix?: string, platform?: string, phase?: string, persistentPlatforms?: string[] }} [meta]
 */
export async function alignCdpPersistentPlatformTabs(context, meta = {}) {
  const logPrefix = meta.logPrefix || "[cdp-align]";
  if (!context) return { closed: 0, kept: 0, aligned: [] };

  const required = resolvePersistent9222Platforms(meta);
  if (!required.length) {
    return pruneCdpContextTabsLegacy(context, meta);
  }

  const endpoint = cdp9222Endpoint();
  const { listCdpPageTargets, openCdpTab, closeCdpTarget, connectCdpTargetPage } =
    await import("./cdp-target-page.js");

  let targets = await listCdpPageTargets(endpoint);
  /** @type {Map<'instagram'|'youtube', { id: string, url?: string }>} */
  const keeperTargets = new Map();
  let closed = 0;

  const rankTarget = (platform, target) => {
    const url = String(target?.url || "");
    if (platform === "instagram") {
      if (isInstagramHomeUrl(url)) return 0;
      if (isInstagramPlatformUrl(url)) return 1;
      return 9;
    }
    if (isYoutubeHomeUrl(url)) return 0;
    if (isYoutubePlatformUrl(url)) return 1;
    return 9;
  };

  const isPlatformTarget = (platform, target) => {
    const url = String(target?.url || "");
    return platform === "instagram" ? isInstagramPlatformUrl(url) : isYoutubePlatformUrl(url);
  };

  for (const platform of required) {
    const candidates = targets
      .filter((t) => isPlatformTarget(platform, t))
      .sort((a, b) => rankTarget(platform, a) - rankTarget(platform, b));
    if (candidates.length) {
      keeperTargets.set(platform, candidates[0]);
      for (let i = 1; i < candidates.length; i++) {
        if (await closeCdpTarget(endpoint, candidates[i].id)) closed += 1;
      }
    }
  }

  targets = await listCdpPageTargets(endpoint);
  const usedIds = new Set([...keeperTargets.values()].map((t) => t.id));

  for (const platform of required) {
    if (keeperTargets.has(platform)) continue;
    const homeUrl = PLATFORM_HOME_URL[platform];
    const disposable = targets.find(
      (t) => !usedIds.has(t.id) && isDisposableCdpTabUrl(String(t.url || ""))
    );
    if (!disposable) continue;
    try {
      const page = await connectCdpTargetPage(disposable);
      await page.goto(homeUrl, { waitUntil: "domcontentloaded", timeout: 45_000 });
      await page.dispose();
      keeperTargets.set(platform, disposable);
      usedIds.add(disposable.id);
    } catch (e) {
      console.warn(`[cdp-align] reuse CDP tab for ${platform} failed: ${e?.message || e}`);
    }
  }

  targets = await listCdpPageTargets(endpoint);
  const keeperIds = new Set([...keeperTargets.values()].map((t) => t.id));
  for (const target of targets) {
    if (keeperIds.has(target.id)) continue;
    if (await closeCdpTarget(endpoint, target.id)) closed += 1;
  }

  targets = await listCdpPageTargets(endpoint);

  for (const platform of required) {
    if (keeperTargets.has(platform)) continue;
    const homeUrl = PLATFORM_HOME_URL[platform];
    try {
      const created = await openCdpTab(endpoint, homeUrl);
      if (created?.id) keeperTargets.set(platform, created);
    } catch (e) {
      console.warn(`[cdp-align] open ${platform} tab failed: ${e?.message || e}`);
    }
  }

  for (const [platform, target] of keeperTargets) {
    const url = String(target.url || "");
    const home = platform === "instagram" ? isInstagramHomeUrl(url) : isYoutubeHomeUrl(url);
    if (home) continue;
    try {
      const page = await connectCdpTargetPage(target);
      await page.goto(PLATFORM_HOME_URL[platform], {
        waitUntil: "domcontentloaded",
        timeout: 45_000,
      });
      await page.dispose();
    } catch (e) {
      console.warn(`[cdp-align] normalize ${platform} home failed: ${e?.message || e}`);
    }
  }

  await listLiveContextPages(context);
  targets = await listCdpPageTargets(endpoint);

  const aligned = required.map((p) => {
    const t =
      keeperTargets.get(p) ||
      targets.find((x) => isPlatformTarget(p, x) && (p === "instagram" ? isInstagramHomeUrl(x.url) : isYoutubeHomeUrl(x.url))) ||
      targets.find((x) => isPlatformTarget(p, x));
    return { platform: p, url: String(t?.url || "").slice(0, 120) };
  });

  const remain = (await listCdpPageTargets(endpoint)).length;

  console.log(
    `${logPrefix} aligned closed=${closed} kept=${remain} required=${required.join(",")}` +
      (meta.platform ? ` taskPlatform=${meta.platform}` : "") +
      (meta.phase ? ` phase=${meta.phase}` : "") +
      ` tabs=${aligned.map((t) => `${t.platform}:${t.url}`).join(" | ")}`
  );

  return { closed, kept: remain, aligned };
}

/**
 * Standard / TikTok-only：只留 1 个 tab（优先 youtube）
 * @param {import('playwright').BrowserContext} context
 * @param {{ logPrefix?: string, platform?: string, phase?: string }} [meta]
 */
async function pruneCdpContextTabsLegacy(context, meta = {}) {
  const logPrefix = meta.logPrefix || "[cdp-prune]";
  if (!context) return { closed: 0, kept: 0 };

  const pages = await listLiveContextPages(context);

  if (pages.length === 0) {
    let kept = 0;
    try {
      await context.newPage();
      kept = 1;
    } catch (e) {
      console.warn(`${logPrefix} newPage on empty context failed: ${e?.message || e}`);
    }
    console.log(
      `${logPrefix} empty context kept_blank=${kept}` +
        (meta.platform ? ` platform=${meta.platform}` : "") +
        (meta.phase ? ` phase=${meta.phase}` : "")
    );
    return { closed: 0, kept };
  }

  const preferYoutube = pages.find((p) => {
    try {
      return String(p.url() || "").includes("youtube.com");
    } catch {
      return false;
    }
  });
  const keeper = preferYoutube || pages[0];
  let closed = 0;
  for (const page of pages) {
    if (page === keeper) continue;
    await forceCloseCdpPage(page);
    closed += 1;
  }

  const remain = context.pages().filter((p) => {
    try {
      return p && !p.isClosed();
    } catch {
      return false;
    }
  }).length;

  console.log(
    `${logPrefix} pruned closed=${closed} kept=${remain}` +
      (meta.platform ? ` platform=${meta.platform}` : "") +
      (meta.phase ? ` phase=${meta.phase}` : "")
  );

  return { closed, kept: remain };
}

/**
 * @param {string} [url]
 */
export function isDisposableCdpTabUrl(url) {
  const u = String(url || "").trim();
  return (
    !u ||
    u === "about:blank" ||
    u.startsWith("chrome://newtab") ||
    u === "chrome://new-tab-page/"
  );
}

/**
 * @param {import('playwright').Page|null|undefined} page
 */
export async function safeCloseCdpPage(page) {
  if (!page) return;
  try {
    if (typeof page.isClosed === "function" && page.isClosed()) return;
    await page.close();
  } catch {
    /* ignore */
  }
}

/**
 * 仅关闭本次任务新建、或明显为空白/失败导航的临时标签
 * @param {import('playwright').Page|null|undefined} page
 * @param {{ created?: boolean, force?: boolean }} [opts]
 */
export async function closeDisposableCdpPage(page, opts = {}) {
  if (!page) return;
  if (opts.force) {
    await forceCloseCdpPage(page);
    return;
  }
  try {
    if (typeof page.isClosed === "function" && page.isClosed()) return;
    const url = page.url();
    if (opts.created || isDisposableCdpTabUrl(url)) {
      await page.close();
    }
  } catch {
    /* ignore */
  }
}

/**
 * 任务标签页结束时强制关闭
 * @param {import('playwright').Page|null|undefined} page
 */
export async function closeCdpTaskPage(page) {
  await forceCloseCdpPage(page);
}

/**
 * 连接后、执行任务前：Lite IG/YT 对齐常驻页；否则 legacy 只留 1 tab
 * @param {import('playwright').BrowserContext} context
 * @param {{ logPrefix?: string, platform?: string, phase?: string, persistentPlatforms?: string[], alignPersistentTabs?: boolean, liteMode?: boolean }} [meta]
 */
export async function pruneCdpContextTabs(context, meta = {}) {
  if (shouldAlignPersistent9222Tabs(meta)) {
    return alignCdpPersistentPlatformTabs(context, meta);
  }
  return pruneCdpContextTabsLegacy(context, meta);
}

/**
 * Lite 会话释放：常驻页仅回首页，不关闭 tab
 * @param {import('playwright').Page|null|undefined} page
 * @param {{ persistent?: boolean, platform?: 'instagram'|'youtube' }} [opts]
 */
export async function releaseLitePersistentPage(page, opts = {}) {
  if (!page || opts.persistent === false) return;
  try {
    if (typeof page.isClosed === "function" && page.isClosed()) return;
  } catch {
    return;
  }
  const platform =
    opts.platform ||
    (isInstagramPlatformUrl(pageUrlSafe(page))
      ? "instagram"
      : isYoutubePlatformUrl(pageUrlSafe(page))
        ? "youtube"
        : null);
  if (platform === "instagram" || platform === "youtube") {
    await navigatePlatformPageHome(page, platform);
    return;
  }
  if (typeof page.dispose === "function") {
    try {
      await page.dispose();
    } catch {
      /* ignore */
    }
  }
}

/**
 * 新建任务页（about:blank），再导航到目标 URL
 * @param {import('playwright').BrowserContext} context
 */
export async function openCdpTaskPage(context) {
  const page = await openCdpContextPage(context);
  try {
    await page.goto("about:blank", { waitUntil: "commit", timeout: 8000 });
  } catch {
    /* blank 导航失败不阻断 */
  }
  return page;
}

/**
 * 页面无响应时 page.close() 可能永久挂起；用 CDP stopLoading + 有界等待强制关页
 * @param {import('playwright').Page|null|undefined} page
 * @param {{ maxWaitMs?: number }} [opts]
 */
export async function forceCloseCdpPage(page, opts = {}) {
  if (!page) return;
  const maxWaitMs = opts.maxWaitMs ?? 4000;
  if (typeof page.isClosed === "function" && page.isClosed()) return;

  const work = async () => {
    try {
      const cdp = await page.context().newCDPSession(page);
      await cdp.send("Page.stopLoading");
    } catch {
      /* ignore */
    }
    try {
      await page.close({ runBeforeUnload: false });
    } catch {
      await safeCloseCdpPage(page);
    }
  };

  await Promise.race([
    work(),
    new Promise((resolve) => setTimeout(resolve, maxWaitMs)),
  ]);
}

/**
 * @param {() => Promise<T>} fn
 * @param {number} ms
 * @param {string} [label]
 * @returns {Promise<T>}
 * @template T
 */
export function runWithHardTimeout(fn, ms, label = "operation") {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${label}_hard_timeout after ${ms}ms`));
    }, ms);
    fn()
      .then((v) => {
        clearTimeout(timer);
        resolve(v);
      })
      .catch((e) => {
        clearTimeout(timer);
        reject(e);
      });
  });
}

/**
 * 导航保护：硬超时 + stopLoading 强制关页 + 1 次重试（默认）。
 * @param {import('playwright').Page} page
 * @param {string} url
 * @param {{
 *   label?: string,
 *   budgetMs?: number,
 *   waitUntil?: "load"|"domcontentloaded"|"networkidle"|"commit",
 *   retries?: number,
 *   createRetryPage?: ((failedPage: import('playwright').Page) => Promise<import('playwright').Page>)
 * }} [opts]
 * @returns {Promise<import('playwright').Page>}
 */
export async function guardedGoto(page, url, opts = {}) {
  const label = opts.label || "goto";
  const budgetMs = Number(opts.budgetMs || 18_000);
  const waitUntil = opts.waitUntil || "domcontentloaded";
  const retries = Math.max(0, Number(opts.retries ?? 1));
  let currentPage = page;
  let attempt = 0;

  while (attempt <= retries) {
    try {
      await runWithHardTimeout(
        () =>
          currentPage.goto(url, {
            waitUntil,
            timeout: budgetMs,
          }),
        budgetMs,
        label
      );
      return currentPage;
    } catch (e) {
      const isLast = attempt >= retries;
      try {
        await forceCloseCdpPage(currentPage, { maxWaitMs: Math.min(5000, budgetMs) });
      } catch {
        /* ignore */
      }
      if (isLast) throw e;
      if (typeof opts.createRetryPage === "function") {
        currentPage = await opts.createRetryPage(currentPage);
      } else {
        currentPage = await openCdpContextPage(currentPage.context());
      }
    }
    attempt += 1;
  }
  return currentPage;
}
