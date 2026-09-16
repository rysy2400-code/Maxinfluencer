/**
 * YouTube innertube 直调：在已登录的 youtube.com 页面上下文内 POST API，无需打开搜索/频道页。
 */

import { extractSearchContinuationToken } from "./yt-search-pagination.js";
import {
  isLiteScraperMode,
  resolveYtLiteDisableEvaluateLock,
} from "../../../scraper/resolve-scraper-mode.js";
import {
  closeYoutubeCdpTabs,
  healYtInnertubeSession,
  isYtInnertubeSessionError,
  noteYtInnertubeProbeResult,
  noteYtInnertubeTabRecycled,
  noteYtInnertubeTaskStart,
  probeYtInnertubeSession,
  resolveYtInnertubeApiTimeoutMs,
  shouldRecycleYtSearchTab,
  ytInnertubeSessionKey,
} from "./yt-innertube-session-health.js";

/** 搜索「视频」Tab 筛选参数（与 sp=EgIQAQ== 等价） */
export const YT_SEARCH_VIDEO_PARAMS = "EgIQAQ==";

/** 频道 /videos 完整列表（sort=dd 纵向 grid）；旧值 EgZ2aWRlb3M%3D 仅返回首页横滑 shelf ~12 条 */
export const YT_BROWSE_VIDEOS_PARAMS = "EgZ2aWRlb3MYAyAAcALyBg0KCzoEIgIIBKIBAggB";
/** @deprecated 首页横滑 shelf，翻页 token 易误指向 About 弹层 */
export const YT_BROWSE_VIDEOS_PARAMS_SHELF = "EgZ2aWRlb3M%3D";

/** 频道 /about Tab（innertube browse body 用裸 base64） */
export const YT_BROWSE_ABOUT_PARAMS_RAW = "EgVhYm91dA==";
/** Invidious 2023-11 更新的 about protobuf params */
export const YT_BROWSE_ABOUT_PARAMS_V2 = "EgVhYm91dPIGBAoCEgA=";
/** @deprecated JSON body 请用 YT_BROWSE_ABOUT_PARAMS_RAW */
export const YT_BROWSE_ABOUT_PARAMS = "EgVhYm91dA%3D%3D";

const BLOCKED_RESOURCE_TYPES = new Set(
  String(process.env.LITE_BLOCK_RESOURCE_TYPES || "image,media,font")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
);

/** 同一 Playwright page 上串行 evaluate，避免并发 postInnertube 导致 Target closed */
const pageEvaluateChains = new WeakMap();

function withPageEvaluateLock(page, fn) {
  if (resolveYtLiteDisableEvaluateLock()) {
    return fn();
  }
  const prev = pageEvaluateChains.get(page) || Promise.resolve();
  const run = prev.then(() => fn());
  pageEvaluateChains.set(
    page,
    run.catch(() => {}).then(() => undefined)
  );
  return run;
}

function walkBrowseIdFromJson(obj, depth = 0) {
  if (depth > 24 || !obj || typeof obj !== "object") return null;
  if (Array.isArray(obj)) {
    for (const x of obj) {
      const found = walkBrowseIdFromJson(x, depth + 1);
      if (found) return found;
    }
    return null;
  }
  const bid =
    obj.browseId ||
    obj.browseEndpoint?.browseId ||
    obj.payload?.browseId ||
    obj.endpoint?.browseEndpoint?.browseId;
  if (typeof bid === "string" && bid.startsWith("UC")) return bid;
  for (const v of Object.values(obj)) {
    if (typeof v === "object" && v) {
      const found = walkBrowseIdFromJson(v, depth + 1);
      if (found) return found;
    }
  }
  return null;
}

/**
 * @param {import('playwright').Page} page
 */
export async function attachLiteResourceBlocker(page) {
  if (BLOCKED_RESOURCE_TYPES.size === 0) return () => {};
  const handler = async (route) => {
    const type = route.request().resourceType();
    if (BLOCKED_RESOURCE_TYPES.has(type)) {
      await route.abort();
      return;
    }
    await route.continue();
  };
  await page.route("**/*", handler);
  return async () => {
    try {
      await page.unroute("**/*", handler);
    } catch {
      /* ignore */
    }
  };
}

/**
 * 初始化 innertube 会话：仅访问 youtube.com 首页一次以加载 ytcfg + cookie
 * @param {import('playwright').BrowserContext} context
 * @param {{ persistent?: boolean, forceNewTab?: boolean }} [options]
 */
export async function acquireYoutubeInnertubeSession(context, options = {}) {
  const forceNewTab = !!options.forceNewTab;
  const persistent =
    !forceNewTab &&
    options.persistent !== false &&
    (options.persistent === true ||
      (isLiteScraperMode() &&
        String(process.env.CDP_9222_PERSIST_PLATFORM_TABS ?? "true") !== "false"));
  const { openCdpTaskPage, closeCdpTaskPage } = await import("../../../cdp/cdp-tab-utils.js");

  let page = null;
  let pageCreated = false;
  let pageMode = "playwright";
  /** @type {{ id?: string }|null} */
  let cdpTarget = null;

  const preferCdp = process.env.YT_LITE_USE_CDP_PAGE !== "0";
  if (preferCdp) {
    try {
      const { acquireYoutubeCdpPage } = await import("../../../cdp/cdp-target-page.js");
      const cdpSession = await acquireYoutubeCdpPage(undefined, {
        forceNew: forceNewTab,
      });
      page = cdpSession.page;
      cdpTarget = cdpSession.target;
      pageMode = "cdp";
    } catch (e) {
      console.warn(`[innertube-direct] CDP page attach failed: ${e.message}`);
    }
  }

  if (!page && context && !forceNewTab) {
    page = context.pages().find((p) => {
      try {
        return p && !p.isClosed() && String(p.url() || "").includes("youtube.com");
      } catch {
        return false;
      }
    });
    if (!page) {
      page = context.pages().find((p) => {
        try {
          return p && !p.isClosed();
        } catch {
          return false;
        }
      });
    }
  }

  if (!page) {
    if (!context) {
      throw new Error("YouTube innertube 会话不可用：无 CDP 上下文");
    }
    page = await openCdpTaskPage(context);
    pageCreated = true;
    pageMode = "playwright";
  }

  /** @type {() => Promise<void>} */
  let unblock = async () => {};
  async function attachBlocker() {
    unblock =
      pageMode === "playwright" && typeof page.route === "function"
        ? await attachLiteResourceBlocker(page)
        : pageMode === "cdp" && typeof page.enableLiteResourceBlocker === "function"
          ? await page.enableLiteResourceBlocker([...BLOCKED_RESOURCE_TYPES])
          : async () => {};
  }
  async function detachBlocker() {
    const fn = unblock;
    unblock = async () => {};
    try {
      await fn();
    } catch {
      /* ignore */
    }
  }

  async function teardownPage() {
    if (pageMode === "cdp" && cdpTarget?.id) {
      try {
        const { closeCdpTarget } = await import("../../../cdp/cdp-target-page.js");
        await closeCdpTarget(undefined, cdpTarget.id);
      } catch {
        /* ignore */
      }
    }
    if (typeof page?.dispose === "function") {
      try {
        await page.dispose();
      } catch {
        /* ignore */
      }
      return;
    }
    if (pageCreated || forceNewTab) {
      try {
        if (!page.isClosed()) await closeCdpTaskPage(page);
      } catch {
        try {
          if (!page.isClosed()) await page.close();
        } catch {
          /* ignore */
        }
      }
    }
  }

  try {
    const currentUrl = typeof page.url === "function" ? page.url() : "";
    if (!String(currentUrl).includes("youtube.com")) {
      await page.goto("https://www.youtube.com", {
        waitUntil: "domcontentloaded",
        timeout: 45_000,
      });
    }
    await page.waitForTimeout(
      Math.min(Math.max(Number(process.env.YT_LITE_SESSION_SETTLE_MS) || 2500, 800), 8000)
    );
    const ready = await waitForInnertubeReady(page, 15_000);
    if (!ready) {
      throw new Error("innertube ytcfg 未就绪，请确认 9222 Chrome 已登录 YouTube");
    }
  } catch (e) {
    await detachBlocker();
    await teardownPage();
    throw e;
  }

  const endpoint = String(
    process.env.CDP_ENDPOINT || "http://127.0.0.1:9222"
  ).replace(/\/$/, "");
  const sessionKey = ytInnertubeSessionKey(endpoint, cdpTarget?.id || cdpTargetIdFallback(page));
  noteYtInnertubeTaskStart(sessionKey);

  async function hardReload() {
    const st = shouldRecycleYtSearchTab(sessionKey);
    if (st.recycle) {
      console.warn(`[innertube-direct] 常驻搜索 tab 预重建（${st.reason}）`);
    }
    return healYtInnertubeSession({
      page,
      sessionKey,
      endpoint,
      level: 0,
      reason: st.recycle ? `recycle_${st.reason}` : "manual_reload",
      waitForReady: waitForInnertubeReady,
    });
  }

  // 常驻 tab 长期复用会让渲染进程堆持续增长（曾出现连续数小时 100% 任务失败），
  // 这里按「任务数 / 存活时长」做预防性重建，任务开始前探针不过则立即自愈。
  const recycleDecision = shouldRecycleYtSearchTab(sessionKey);
  if (recycleDecision.recycle) {
    const he = await hardReload();
    console.warn(
      `[innertube-direct] 搜索 tab 预重建完成 reason=${recycleDecision.reason} ` +
        `reloaded=${he.reloaded} closedTabs=${he.closedTabs}`
    );
    if (!he.reloaded && !he.closedTabs) {
      // 页已不可用：交给调用方重新 acquire（下一次会拿到全新 tab）
      await teardownPage();
      throw new Error("innertube 会话重建失败（搜索 tab 不可用）");
    }
  }

  const probe = await probeYtInnertubeSession(page);
  noteYtInnertubeProbeResult(sessionKey, probe.ok);
  if (!probe.ok) {
    console.warn(
      `[innertube-direct] 会话探针失败(${probe.ms}ms): ${probe.error}，开始自愈`
    );
    let healed = await healYtInnertubeSession({
      page,
      sessionKey,
      endpoint,
      level: 0,
      reason: probe.error || "probe_failed",
      waitForReady: waitForInnertubeReady,
    });
    let probe2 = healed.reloaded ? await probeYtInnertubeSession(page) : { ok: false };
    if (!probe2.ok) {
      // 软自愈无效：重启 Chrome 后重建会话
      healed = await healYtInnertubeSession({
        page,
        sessionKey,
        endpoint,
        level: 1,
        reason: probe.error || "probe_failed",
      });
      await teardownPage();
      if (!healed.cdpReady) {
        throw new Error(
          `YouTube innertube 会话不可用（探针=${probe.error}，Chrome 重启=${healed.restartedChrome}）`
        );
      }
      throw new Error(
        `YouTube innertube 会话已重启 Chrome，需要重新建立会话（探针=${probe.error}）`
      );
    }
    console.log(`[innertube-direct] 会话自愈成功（探针 ${probe.ms}ms → 恢复）`);
    noteYtInnertubeTabRecycled(sessionKey);
  }

  // 资源拦截（Fetch.enable + 逐请求 continue）会与导航/重载互相干扰，
  // 因此只在会话确认健康后再挂上。
  await attachBlocker();

  return {
    page,
    persistent,
    sessionKey,
    endpoint,
    /** 本会话处理过一次搜索（用于常驻 tab 回收计数） */
    noteTaskStart: () => noteYtInnertubeTaskStart(sessionKey),
    /** 主动重建当前页（探针失败 / 连续失败时调用） */
    heal: async ({ level = 0, reason = "manual" } = {}) => {
      // 重载期间摘掉资源拦截，避免 Fetch.enable 与导航互相卡死
      await detachBlocker();
      let he;
      try {
        he = await healYtInnertubeSession({
          page,
          sessionKey,
          endpoint,
          level,
          reason,
          waitForReady: waitForInnertubeReady,
        });
      } finally {
        if (level === 0) await attachBlocker();
      }
      if (he.reloaded) noteYtInnertubeTabRecycled(sessionKey);
      return he;
    },
    /** 搜索首屏：失败时先自愈再重试，仍失败返回 null（错误原因见 getLastInnertubeError） */
    fetchSearchFirstPage: async (keyword, { retries = 1 } = {}) => {
      for (let attempt = 0; attempt <= retries; attempt += 1) {
        const { json, error } = await fetchSearchFirstPageDetailed(page, keyword);
        if (json) return json;
        const err = error || getLastInnertubeError();
        if (attempt >= retries) {
          lastSearchFirstPageError = err;
          return null;
        }
        console.warn(
          `[innertube-direct] 搜索首屏失败（${err}），自愈后重试 ${attempt + 1}/${retries}`
        );
        await detachBlocker();
        try {
          await healYtInnertubeSession({
            page,
            sessionKey,
            endpoint,
            level: 0,
            reason: `search_first_page:${err}`,
            waitForReady: waitForInnertubeReady,
          });
        } finally {
          await attachBlocker();
        }
        await page.waitForTimeout?.(500);
      }
      return null;
    },
    async dispose() {
      await detachBlocker();
      if (persistent) {
        try {
          const { releaseLitePersistentPage } = await import("../../../cdp/cdp-tab-utils.js");
          await releaseLitePersistentPage(page, { persistent: true, platform: "youtube" });
        } catch {
          /* ignore */
        }
        return;
      }
      await teardownPage();
    },
  };
}

/**
 * @param {import('playwright').Page} page
 * @param {number} timeoutMs
 */
export async function waitForInnertubeReady(page, timeoutMs = 10_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const ok = await page.evaluate(() => {
      const ytcfg = window.ytcfg?.data_ || {};
      const apiKey =
        ytcfg.INNERTUBE_API_KEY ||
        (typeof ytcfg.get === "function" ? ytcfg.get("INNERTUBE_API_KEY") : null);
      const ctx =
        ytcfg.INNERTUBE_CONTEXT ||
        (typeof ytcfg.get === "function" ? ytcfg.get("INNERTUBE_CONTEXT") : null);
      return !!(apiKey && ctx);
    });
    if (ok) return true;
    await page.waitForTimeout(300);
  }
  return false;
}

/**
 * @param {import('playwright').Page} page
 * @param {string} endpoint search | browse | next
 * @param {object} body
 */
export async function postInnertube(page, endpoint, body) {
  const result = await postInnertubeDetailed(page, endpoint, body);
  return result.json;
}

/** 最近一次 innertube 调用失败原因（供上层判定是否需要自愈） */
let lastInnertubeError = null;
/** 最近一次搜索首屏失败原因（自愈重试后仍失败时记录） */
let lastSearchFirstPageError = null;

export function getLastInnertubeError() {
  return lastInnertubeError;
}

export function getLastSearchFirstPageError() {
  return lastSearchFirstPageError;
}

/** CDP 页包装对象上带的 9222 target id（用于常驻 tab 统计键） */
function cdpTargetIdFallback(page) {
  try {
    return page?._ytCdpTargetId || page?._target?.id || null;
  } catch {
    return null;
  }
}

/**
 * postInnertube 的详细版本：返回 { json, error }。
 * 页内 fetch 自带超时（默认 25s），避免网络挂死时白等 CDP 45s 并堵住 evaluate 队列。
 *
 * @param {import('playwright').Page} page
 * @param {string} endpoint
 * @param {object} body
 */
export async function postInnertubeDetailed(page, endpoint, body) {
  const apiTimeoutMs = resolveYtInnertubeApiTimeoutMs();
  try {
    const out = await withPageEvaluateLock(page, () =>
      page.evaluate(
        async ({ endpoint, body, apiTimeoutMs }) => {
          const ytcfg = window.ytcfg?.data_ || {};
          const apiKey =
            ytcfg.INNERTUBE_API_KEY ||
            (typeof ytcfg.get === "function" ? ytcfg.get("INNERTUBE_API_KEY") : null);
          const ctx =
            ytcfg.INNERTUBE_CONTEXT ||
            (typeof ytcfg.get === "function" ? ytcfg.get("INNERTUBE_CONTEXT") : null);
          if (!apiKey || !ctx) return { __error: "missing_ytcfg" };

          const url = `https://www.youtube.com/youtubei/v1/${endpoint}?key=${encodeURIComponent(apiKey)}&prettyPrint=false`;
          const payload = { ...body, context: body.context || ctx };
          const ctrl = new AbortController();
          const timer = setTimeout(() => ctrl.abort(), apiTimeoutMs);
          try {
            const res = await fetch(url, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              credentials: "include",
              signal: ctrl.signal,
              body: JSON.stringify(payload),
            });
            if (!res.ok) {
              let text = "";
              try {
                text = (await res.text()).slice(0, 160);
              } catch {
                /* ignore */
              }
              return { __error: `http_${res.status}${text ? ` ${text}` : ""}` };
            }
            return await res.json();
          } catch (e) {
            const msg = e?.name === "AbortError" ? "api_timeout" : String(e?.message || e);
            return { __error: msg };
          } finally {
            clearTimeout(timer);
          }
        },
        { endpoint, body, apiTimeoutMs }
      )
    );
    if (!out || out.__error) {
      lastInnertubeError = String(out?.__error || "empty");
      console.warn(`[innertube-direct] ${endpoint} failed: ${lastInnertubeError}`);
      return { json: null, error: lastInnertubeError };
    }
    lastInnertubeError = null;
    return { json: out, error: null };
  } catch (e) {
    lastInnertubeError = String(e?.message || e);
    console.warn(`[innertube-direct] ${endpoint} evaluate: ${lastInnertubeError}`);
    return { json: null, error: lastInnertubeError };
  }
}

export { isYtInnertubeSessionError };

/**
 * @handle → UC channelId（browse 不接受裸 @handle）
 * @param {import('playwright').Page} page
 * @param {string} handleOrUrl
 */
export async function resolveChannelBrowseId(page, handleOrUrl) {
  const raw = String(handleOrUrl || "").trim();
  if (!raw) return null;
  if (raw.startsWith("UC")) return raw;
  const url = raw.startsWith("http")
    ? raw
    : `https://www.youtube.com/@${encodeURIComponent(raw.replace(/^@/, ""))}`;
  const json = await postInnertube(page, "navigation/resolve_url", {
    url,
    parse: true,
  });
  const browseId = walkBrowseIdFromJson(json);
  if (browseId) return browseId;
  console.warn(`[innertube-direct] resolve_url 未得到 UC browseId: ${url}`);
  return null;
}

/**
 * @param {{ browseId?: string, handle?: string }} target
 */
export async function resolveBrowseTarget(page, target = {}) {
  const browseId = target.browseId?.startsWith("UC") ? target.browseId : null;
  if (browseId) return browseId;
  if (target.handle) {
    return resolveChannelBrowseId(page, target.handle);
  }
  return null;
}

/**
 * 关键词搜索（视频 Tab）首屏
 * @param {import('playwright').Page} page
 * @param {string} keyword
 */
export async function fetchSearchFirstPage(page, keyword) {
  return postInnertube(page, "search", {
    query: String(keyword || "").trim(),
    params: YT_SEARCH_VIDEO_PARAMS,
  });
}

/** 首屏搜索（带错误原因），避免并发 enrich 调用污染全局 lastInnertubeError */
async function fetchSearchFirstPageDetailed(page, keyword) {
  return postInnertubeDetailed(page, "search", {
    query: String(keyword || "").trim(),
    params: YT_SEARCH_VIDEO_PARAMS,
  });
}

/**
 * @param {import('playwright').Page} page
 * @param {string} continuationToken
 */
export async function fetchSearchContinuation(page, continuationToken) {
  if (!continuationToken) return null;
  return postInnertube(page, "search", { continuation: continuationToken });
}

/**
 * worker 搜索阶段失败后的 YouTube 会话恢复入口。
 * level 0（软）：关掉 9222 上的 youtube tab，下一次 acquire 得到全新渲染上下文；
 * level 1（硬）：重启 9222 Chrome（guard/systemd 拉起）并等待 CDP 恢复。
 *
 * 背景：HK YouTube 机器没有 tk-ip 配置，worker 原本的「轮换 IP 重试」是 no-op，
 * 坏掉的常驻 tab 会被一直复用，导致整台机器连续数小时 100% 任务失败。
 *
 * @param {{ level?: number, reason?: string }} [options]
 */
export async function recoverYoutubeSearchSession(options = {}) {
  const level = Math.max(0, Math.min(Number(options.level) || 0, 1));
  const reason = String(options.reason || "yt_search_failed").slice(0, 120);
  const endpoint = String(process.env.CDP_ENDPOINT || "http://127.0.0.1:9222").replace(
    /\/$/,
    ""
  );
  if (level >= 1) {
    const out = await healYtInnertubeSession({ endpoint, level: 1, reason });
    return { ...out, reason };
  }
  const closed = await closeYoutubeCdpTabs(endpoint);
  return { level: 0, reason, closedTabs: closed.closed, seenTabs: closed.seen };
}

/**
 * 频道 /videos 首屏
 * @param {import('playwright').Page} page
 * @param {{ browseId?: string, handle?: string }} target
 */
export async function fetchChannelVideosFirstPage(page, target = {}) {
  const browseId = await resolveBrowseTarget(page, target);
  if (!browseId) return null;
  const params = process.env.YT_BROWSE_VIDEOS_PARAMS || YT_BROWSE_VIDEOS_PARAMS;
  return postInnertube(page, "browse", {
    browseId,
    params,
  });
}

/**
 * 频道 /about
 * @param {import('playwright').Page} page
 * @param {{ browseId?: string, handle?: string }} target
 */
export async function fetchChannelAbout(page, target = {}) {
  const browseId = await resolveBrowseTarget(page, target);
  if (!browseId) return null;
  const params =
    process.env.YT_BROWSE_ABOUT_PARAMS ||
    YT_BROWSE_ABOUT_PARAMS_RAW;
  return postInnertube(page, "browse", {
    browseId,
    params,
  });
}

function walkAboutChannelViewModel(obj, depth = 0) {
  if (depth > 24 || !obj || typeof obj !== "object") return null;
  if (Array.isArray(obj)) {
    for (const x of obj) {
      const found = walkAboutChannelViewModel(x, depth + 1);
      if (found) return found;
    }
    return null;
  }
  if (obj.aboutChannelViewModel) return obj.aboutChannelViewModel;
  for (const v of Object.values(obj)) {
    if (typeof v === "object" && v) {
      const found = walkAboutChannelViewModel(v, depth + 1);
      if (found) return found;
    }
  }
  return null;
}

/**
 * 从 browse /about 首屏 JSON 提取 About 弹层 continuation token（yt-dlp #8634 / Scrapfly 路径）
 * @param {object|null} json
 */
export function extractAboutBrowseContinuationToken(json) {
  if (!json || typeof json !== "object") return null;
  const stack = [json];
  while (stack.length) {
    const cur = stack.pop();
    if (!cur || typeof cur !== "object") continue;
    if (Array.isArray(cur)) {
      stack.push(...cur);
      continue;
    }
    const token =
      cur.continuationCommand?.token ||
      cur.continuationEndpoint?.continuationCommand?.token ||
      null;
    if (token && typeof token === "string") return token;
    for (const v of Object.values(cur)) {
      if (typeof v === "object" && v) stack.push(v);
    }
  }
  return null;
}

/**
 * 两步 innertube browse：about tab → continuation → aboutChannelViewModel（含 country）
 * 无需 page.goto(/about)。参考 Invidious about.cr、yt-dlp #8634、Scrapfly aboutChannelViewModel。
 * @param {import('playwright').Page} page
 * @param {{ browseId?: string, handle?: string }} target
 * @returns {Promise<{ browseJson: object, viewModel: object|null, source: string }|null>}
 */
export async function fetchChannelAboutViewModel(page, target = {}) {
  const browseId = await resolveBrowseTarget(page, target);
  if (!browseId) return null;

  const params =
    process.env.YT_BROWSE_ABOUT_PARAMS ||
    YT_BROWSE_ABOUT_PARAMS_RAW;

  const first = await postInnertube(page, "browse", { browseId, params });
  if (!first) return null;

  let vm = walkAboutChannelViewModel(first);
  if (vm) {
    return { browseJson: first, viewModel: vm, source: "innertube_about_api" };
  }

  const token = extractAboutBrowseContinuationToken(first);
  if (!token) {
    return { browseJson: first, viewModel: null, source: "innertube_about_shell" };
  }

  const second = await postInnertube(page, "browse", { continuation: token });
  vm = walkAboutChannelViewModel(second);
  return {
    browseJson: second || first,
    viewModel: vm || null,
    source: vm ? "innertube_about_continuation" : "innertube_about_no_vm",
  };
}

/**
 * browse/next continuation
 * @param {import('playwright').Page} page
 * @param {string} continuationToken
 */
export async function fetchBrowseContinuation(page, continuationToken) {
  if (!continuationToken) return null;
  let json = await postInnertube(page, "browse", { continuation: continuationToken });
  if (json) return json;
  return postInnertube(page, "next", { continuation: continuationToken });
}

export function resolveLiteContinuationConfig() {
  return {
    maxPages: Math.min(
      Math.max(Number(process.env.YT_LITE_MAX_CONTINUATION_PAGES || 40), 3),
      80
    ),
    delayMs: Math.min(
      Math.max(Number(process.env.YT_LITE_CONTINUATION_DELAY_MS || 40), 0),
      300
    ),
    stallPages: Math.max(Number(process.env.YT_LITE_CONT_STALL_PAGES || 2), 1),
  };
}

/**
 * 通用 continuation 翻页
 * @param {import('playwright').Page} page
 * @param {object[]} jsonSources
 * @param {(json: object) => void} onJson
 * @param {{ fetchPage: (token: string) => Promise<object|null>, getProgress?: () => string, maxPages?: number }} options
 */
export async function paginateViaContinuation(page, jsonSources, onJson, options = {}) {
  const cfg = resolveLiteContinuationConfig();
  const maxPages = options.maxPages ?? cfg.maxPages;
  const delayMs = options.delayMs ?? cfg.delayMs;
  const stallLimit = options.stallPages ?? cfg.stallPages;
  const fetchPage = options.fetchPage || fetchSearchContinuation;

  let token = options.startToken ?? null;
  if (!token && Array.isArray(jsonSources)) {
    for (let i = jsonSources.length - 1; i >= 0 && !token; i--) {
      token = extractSearchContinuationToken(jsonSources[i]);
    }
  }
  if (!token) return { pages: 0 };

  let pages = 0;
  let prevProgress = options.getProgress?.() ?? "";
  let stall = 0;

  while (token && pages < maxPages) {
    const json = await fetchPage(page, token);
    if (!json) break;
    onJson(json);
    pages += 1;

    const progress = options.getProgress?.() ?? "";
    if (progress === prevProgress) {
      stall += 1;
      if (stall >= stallLimit) break;
    } else {
      stall = 0;
      prevProgress = progress;
    }

    token = extractSearchContinuationToken(json);
    if (delayMs > 0) await page.waitForTimeout(delayMs);
  }

  return { pages };
}
