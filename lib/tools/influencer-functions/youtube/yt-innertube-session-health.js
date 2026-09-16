/**
 * YouTube Lite innertube 会话健康与自愈。
 *
 * 背景（2026-09 线上故障）：9222 常驻 YouTube tab 一直被复用、从不重建，
 * 加上 enrich 单 tab 30 并发拉取频道 JSON，渲染进程 V8 堆持续增长，
 * 最终表现为首页 fetch 挂死（CDP timeout: Runtime.evaluate）或直接
 * TypeError: Failed to fetch。此时 tab 仍在 youtube.com、location.href 正常，
 * 旧逻辑只校验 URL 就认为会话健康，于是同一台机器上后续每个任务都失败
 * （曾出现连续 200+ 任务 100% 失败，直到渲染进程 OOM 崩溃才恢复）。
 *
 * 本模块提供：真实网络探针 + 分级自愈（重建 tab → 重启 Chrome）。
 */

const DEFAULT_PROBE_TIMEOUT_MS = 12_000;
// 线上实测：2C2G 机器上 Chrome 常驻 youtube tab 的渲染进程会涨到 ~900MB，
// 触发 V8 heap limit OOM / 页内 fetch 挂死。重建一次约 3s，远低于一个任务 40~90s，
// 因此阈值取保守值，让 JS 堆频繁归零。
const DEFAULT_TAB_MAX_AGE_MS = 15 * 60_000;
const DEFAULT_TAB_MAX_TASKS = 15;

/** @type {Map<string, {firstSeenAt:number, tasks:number, lastReloadAt:number, heals:number, lastHealAt:number, probeFailures:number}>} */
const tabStats = new Map();
/** 统计表上限：enrich 每次新建 tab 都是新 targetId，需要防 Map 无限增长 */
const TAB_STATS_MAX_ENTRIES = 200;

function envNumber(name, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const raw = process.env[name];
  const n = Number(raw);
  if (raw == null || raw === "" || !Number.isFinite(n)) return fallback;
  if (n < min) return min;
  return Math.min(n, max);
}

/** 常驻搜索 tab 重建阈值：处理 N 个任务后强制重建（0=仅按时间/探针判定） */
export function resolveYtSearchTabRecycleTasks() {
  return envNumber("YT_LITE_SEARCH_TAB_RECYCLE_TASKS", DEFAULT_TAB_MAX_TASKS, { min: 0 });
}

/** 常驻搜索 tab 最长存活时间，超过即重建（0=禁用按时间重建） */
export function resolveYtSearchTabRecycleMs() {
  return envNumber("YT_LITE_SEARCH_TAB_RECYCLE_MS", DEFAULT_TAB_MAX_AGE_MS, { min: 0 });
}

/** innertube 页内 fetch 超时：避免网络挂死时白等 CDP 45s 并堵住 evaluate 队列 */
export function resolveYtInnertubeApiTimeoutMs() {
  return envNumber("YT_LITE_API_TIMEOUT_MS", 25_000, { min: 3_000, max: 120_000 });
}

export function ytInnertubeSessionKey(endpoint, targetId) {
  return `${String(endpoint || "").replace(/\/$/, "")}#${String(targetId || "default")}`;
}

export function getYtInnertubeTabStats(sessionKey) {
  const key = String(sessionKey || "");
  let st = tabStats.get(key);
  if (!st) {
    if (tabStats.size >= TAB_STATS_MAX_ENTRIES) {
      // 淘汰最旧的一半，避免长跑进程因 tab 反复新建导致 Map 无限增长
      const byAge = [...tabStats.entries()].sort(
        (a, b) => (a[1].lastReloadAt || a[1].firstSeenAt) - (b[1].lastReloadAt || b[1].firstSeenAt)
      );
      for (const [k] of byAge.slice(0, Math.ceil(byAge.length / 2))) {
        tabStats.delete(k);
      }
    }
    st = {
      firstSeenAt: Date.now(),
      tasks: 0,
      lastReloadAt: Date.now(),
      heals: 0,
      lastHealAt: 0,
      probeFailures: 0,
    };
    tabStats.set(key, st);
  }
  return st;
}

/**
 * 是否应当主动重建常驻搜索 tab（渲染进程堆增长前的预防性重建）
 * @param {string} sessionKey
 */
export function shouldRecycleYtSearchTab(sessionKey) {
  const st = getYtInnertubeTabStats(sessionKey);
  const maxTasks = resolveYtSearchTabRecycleTasks();
  const maxAgeMs = resolveYtSearchTabRecycleMs();
  const now = Date.now();
  if (maxTasks > 0 && st.tasks >= maxTasks) {
    return { recycle: true, reason: `tasks>=${maxTasks}` };
  }
  if (maxAgeMs > 0 && now - st.lastReloadAt >= maxAgeMs) {
    return { recycle: true, reason: `age>=${Math.round(maxAgeMs / 1000)}s` };
  }
  return { recycle: false, reason: null };
}

/** 标记一次任务占用（任务开始时调用） */
export function noteYtInnertubeTaskStart(sessionKey) {
  const st = getYtInnertubeTabStats(sessionKey);
  st.tasks += 1;
  return st;
}

/** 记录一次 tab 重建 */
export function noteYtInnertubeTabRecycled(sessionKey) {
  const st = getYtInnertubeTabStats(sessionKey);
  st.tasks = 0;
  st.lastReloadAt = Date.now();
  st.probeFailures = 0;
  return st;
}

export function noteYtInnertubeProbeResult(sessionKey, ok) {
  const st = getYtInnertubeTabStats(sessionKey);
  if (ok) {
    st.probeFailures = 0;
  } else {
    st.probeFailures += 1;
  }
  return st;
}

/** 清空统计：下一次 acquire 视为全新 tab，强制重建 */
export function invalidateYtInnertubeTabStats(sessionKey = null) {
  if (sessionKey == null) {
    tabStats.clear();
    return;
  }
  tabStats.delete(String(sessionKey));
}

/**
 * 真实网络探针：页内 POST 一次最轻的 innertube 接口。
 * 只校验 location.href 无法发现「页面在、网络死」的坏会话。
 *
 * @param {import('playwright').Page} page
 * @param {{ timeoutMs?: number }} [options]
 * @returns {Promise<{ ok: boolean, error: string|null, ms: number, missingYtcfg?: boolean }>}
 */
export async function probeYtInnertubeSession(page, options = {}) {
  const timeoutMs = Math.max(Number(options.timeoutMs) || DEFAULT_PROBE_TIMEOUT_MS, 2000);
  const t0 = Date.now();
  const evaluate = typeof page.evaluate === "function" ? page.evaluate.bind(page) : null;
  if (!evaluate) {
    return { ok: false, error: "no_evaluate", ms: 0 };
  }
  try {
    const result = await evaluate(
      async ({ timeoutMs }) => {
        const ytcfg = window.ytcfg?.data_ || {};
        const get = (k) =>
          ytcfg[k] || (typeof ytcfg.get === "function" ? ytcfg.get(k) : null);
        const apiKey = get("INNERTUBE_API_KEY");
        const context = get("INNERTUBE_CONTEXT");
        if (!apiKey || !context) {
          return { ok: false, error: "missing_ytcfg", missingYtcfg: true };
        }
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), timeoutMs);
        try {
          const url =
            "https://www.youtube.com/youtubei/v1/navigation/resolve_url" +
            `?key=${encodeURIComponent(apiKey)}&prettyPrint=false`;
          const res = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            credentials: "include",
            signal: ctrl.signal,
            body: JSON.stringify({
              context,
              url: "https://www.youtube.com/@YouTube",
              parse: false,
            }),
          });
          await res.text();
          // 4xx（429 除外）说明网络与 API 可达，只是探针参数不适用：仍算健康，
          // 否则会误判成坏会话并频繁重启 Chrome。
          if (!res.ok && (res.status >= 500 || res.status === 429)) {
            return { ok: false, error: `http_${res.status}` };
          }
          return { ok: true, error: null };
        } catch (e) {
          const msg = String(e?.name === "AbortError" ? "probe_timeout" : e?.message || e);
          return { ok: false, error: msg };
        } finally {
          clearTimeout(timer);
        }
      },
      { timeoutMs: timeoutMs + 3000 }
    );
    return { ...(result || { ok: false, error: "empty_probe" }), ms: Date.now() - t0 };
  } catch (e) {
    return { ok: false, error: String(e?.message || e), ms: Date.now() - t0 };
  }
}

/**
 * 重建页：重新导航到 YouTube 首页（绕过缓存），等待 ytcfg 就绪。
 * @param {import('playwright').Page} page
 * @param {{ waitForReady?: (page:any, timeoutMs:number) => Promise<boolean>, timeoutMs?: number }} [options]
 */
export async function reloadYtInnertubePage(page, options = {}) {
  const timeoutMs = Math.max(Number(options.timeoutMs) || 45_000, 5000);
  const target = "https://www.youtube.com/";
  let navigated = false;
  try {
    if (typeof page.goto === "function") {
      await page.goto(target, { waitUntil: "domcontentloaded", timeout: timeoutMs });
      navigated = true;
    }
  } catch (e) {
    console.warn(`[yt-innertube-health] 重建导航失败: ${e?.message || e}`);
  }
  try {
    await page.waitForTimeout?.(1200);
  } catch {
    /* ignore */
  }
  let ready = false;
  if (navigated && typeof options.waitForReady === "function") {
    try {
      ready = !!(await options.waitForReady(page, 15_000));
    } catch {
      ready = false;
    }
  }
  return { navigated, ready };
}

/** 关闭 9222 上所有 youtube.com 标签，让下一次 acquire 打开全新 tab（清掉渲染进程内的旧上下文） */
export async function closeYoutubeCdpTabs(endpoint) {
  const { listCdpPageTargets, closeCdpTarget } = await import("../../../cdp/cdp-target-page.js");
  const ep = String(endpoint || process.env.CDP_ENDPOINT || "http://127.0.0.1:9222");
  let targets = [];
  try {
    targets = await listCdpPageTargets(ep);
  } catch {
    targets = [];
  }
  const youtubeTabs = targets.filter((t) =>
    String(t.url || "").includes("youtube.com")
  );
  let closed = 0;
  for (const t of youtubeTabs) {
    try {
      if (await closeCdpTarget(ep, t.id)) closed += 1;
    } catch {
      /* ignore */
    }
  }
  return { closed, seen: youtubeTabs.length };
}

/**
 * 分级自愈：
 *  level 0（软）：重载当前页，失败或仍探针不过则关掉 youtube tab
 *  level 1（硬）：重启 9222 Chrome（guard/systemd 拉起），等待 CDP 恢复
 *
 * @param {{ page?: any, sessionKey?: string, endpoint?: string, level?: number, reason?: string, waitForReady?: Function }} params
 */
export async function healYtInnertubeSession(params = {}) {
  const level = Math.max(0, Math.min(Number(params.level) || 0, 1));
  const reason = String(params.reason || "session_unhealthy").slice(0, 160);
  const sessionKey = params.sessionKey || null;
  const out = { level, reason, reloaded: false, closedTabs: 0, restartedChrome: false, cdpReady: null };

  if (sessionKey) {
    const st = getYtInnertubeTabStats(sessionKey);
    st.heals += 1;
    st.lastHealAt = Date.now();
  }

  if (level === 0) {
    if (params.page) {
      const res = await reloadYtInnertubePage(params.page, {
        waitForReady: params.waitForReady,
      });
      out.reloaded = res.ready;
      if (res.ready) {
        // 重载成功即完成一次「回收」：重置任务计数与存活时长基准
        if (sessionKey) noteYtInnertubeTabRecycled(sessionKey);
        return out;
      }
    }
    const closed = await closeYoutubeCdpTabs(params.endpoint);
    out.closedTabs = closed.closed;
    if (sessionKey) invalidateYtInnertubeTabStats(sessionKey);
    return out;
  }

  const closed = await closeYoutubeCdpTabs(params.endpoint);
  out.closedTabs = closed.closed;
  if (sessionKey) invalidateYtInnertubeTabStats(sessionKey);
  try {
    const { requestChrome9222Restart, waitForCdp9222Ready } = await import(
      "../../../cdp/cdp-chrome-restart.js"
    );
    out.restartedChrome = await requestChrome9222Restart(`yt_innertube_${reason}`);
    if (out.restartedChrome) {
      await new Promise((r) => setTimeout(r, Number(process.env.CDP_RESTART_SETTLE_MS) || 8000));
    }
    out.cdpReady = await waitForCdp9222Ready(
      Number(process.env.CDP_RESTART_WAIT_MS) || 30_000
    );
  } catch (e) {
    console.warn(`[yt-innertube-health] Chrome 重启失败: ${e?.message || e}`);
  }
  return out;
}

/** 判断错误信息是否属于「会话/网络坏掉」而非「关键词真的没结果」 */
export function isYtInnertubeSessionError(message) {
  return /missing_ytcfg|http_5\d\d|Failed to fetch|CDP timeout|Runtime\.evaluate|probe_timeout|aborted|network|ERR_|session unavailable|会话不可用|首屏失败/i.test(
    String(message || "")
  );
}
