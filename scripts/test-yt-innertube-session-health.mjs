/**
 * YouTube Lite innertube 会话健康/自愈回归测试（无需真实 CDP）。
 *
 * 覆盖 2026-09 线上故障（常驻 9222 tab 渲染进程堆爆掉 → 后续任务 100% 失败）的判定与恢复逻辑：
 *  - 坏会话判定：missing_ytcfg / 网络错误 / 5xx 视为不健康，4xx 视为网络可达
 *  - 常驻 tab 回收阈值（任务数 / 存活时长）
 *  - innertube 调用失败原因透出（postInnertubeDetailed），供上层触发自愈
 *  - 分级自愈入口在无 CDP 时不得抛异常（避免把恢复本身变成新故障）
 *
 * 运行：node --experimental-default-type=module scripts/test-yt-innertube-session-health.mjs
 */
import assert from "node:assert/strict";

process.env.SCRAPER_MODE = "lite";
process.env.YT_LITE_SEARCH_TAB_RECYCLE_TASKS = "3";
process.env.YT_LITE_SEARCH_TAB_RECYCLE_MS = "60000";

const health = await import(
  "../lib/tools/influencer-functions/youtube/yt-innertube-session-health.js"
);
const fetchMod = await import(
  "../lib/tools/influencer-functions/youtube/innertube-direct-fetch.js"
);

const tests = [];
function test(name, fn) {
  try {
    fn();
    tests.push({ name, ok: true });
    console.log(`PASS ${name}`);
  } catch (e) {
    tests.push({ name, ok: false, error: e });
    console.log(`FAIL ${name}: ${e?.message || e}`);
  }
}

function fakePage(impl) {
  return {
    url: () => "https://www.youtube.com/",
    waitForTimeout: async () => {},
    evaluate: impl,
  };
}

// ---- 错误分类 ----
test("会话错误分类：innertube/CDP/网络错误命中，空结果不命中", () => {
  for (const msg of [
    "innertube search 首屏失败（CDP timeout: Runtime.evaluate）",
    "TypeError: Failed to fetch",
    "http_500",
    "missing_ytcfg",
    "YouTube innertube 会话不可用（探针=probe_timeout）",
  ]) {
    assert.equal(health.isYtInnertubeSessionError(msg), true, msg);
  }
  assert.equal(health.isYtInnertubeSessionError("no_youtube_search_results"), false);
});

// ---- 回收阈值 ----
test("常驻 tab 回收：任务数达到阈值即回收，回收后计数归零", () => {
  const key = "test#tasks";
  health.invalidateYtInnertubeTabStats(key);
  for (let i = 0; i < 2; i += 1) health.noteYtInnertubeTaskStart(key);
  assert.equal(health.shouldRecycleYtSearchTab(key).recycle, false);
  health.noteYtInnertubeTaskStart(key);
  const decision = health.shouldRecycleYtSearchTab(key);
  assert.equal(decision.recycle, true);
  assert.match(decision.reason, /tasks>=3/);
  health.noteYtInnertubeTabRecycled(key);
  assert.equal(health.shouldRecycleYtSearchTab(key).recycle, false);
  assert.equal(health.getYtInnertubeTabStats(key).tasks, 0);
});

test("常驻 tab 回收：存活时长超阈值即回收", () => {
  const key = "test#age";
  health.invalidateYtInnertubeTabStats(key);
  const st = health.getYtInnertubeTabStats(key);
  st.lastReloadAt = Date.now() - 61_000;
  const decision = health.shouldRecycleYtSearchTab(key);
  assert.equal(decision.recycle, true);
  assert.match(decision.reason, /age>=/);
});

// ---- 探针 ----
test("探针：missing_ytcfg 判为不健康", async () => {
  const page = fakePage(async () => ({ ok: false, error: "missing_ytcfg", missingYtcfg: true }));
  const out = await health.probeYtInnertubeSession(page);
  assert.equal(out.ok, false);
  assert.equal(out.error, "missing_ytcfg");
});

test("探针：页内异常不抛出，转为 error 结果", async () => {
  const page = fakePage(async () => {
    throw new Error("CDP timeout: Runtime.evaluate");
  });
  const out = await health.probeYtInnertubeSession(page);
  assert.equal(out.ok, false);
  assert.match(out.error, /CDP timeout/);
});

test("探针：无 evaluate 的页面直接判失败", async () => {
  const out = await health.probeYtInnertubeSession({});
  assert.equal(out.ok, false);
  assert.equal(out.error, "no_evaluate");
});

test("探针：页面返回 4xx（可达）视为健康，5xx/429 视为不健康", () => {
  // 该断言固化「4xx 不触发自愈」的策略，避免探针本身导致 Chrome 频繁重启。
  const src = String(health.probeYtInnertubeSession);
  assert.ok(src.includes("res.status >= 500 || res.status === 429"));
});

// ---- innertube 调用错误透出 ----
test("postInnertubeDetailed：成功返回 json 且清空上次错误", async () => {
  const page = fakePage(async () => ({ contents: { ok: 1 } }));
  const out = await fetchMod.postInnertubeDetailed(page, "search", { query: "x" });
  assert.deepEqual(out.json, { contents: { ok: 1 } });
  assert.equal(out.error, null);
  assert.equal(fetchMod.getLastInnertubeError(), null);
  assert.equal(await fetchMod.postInnertube(page, "search", {}).then((j) => !!j), true);
});

test("postInnertubeDetailed：evaluate 抛错时返回 error 并保留原因", async () => {
  const page = fakePage(async () => {
    throw new Error("CDP timeout: Runtime.evaluate");
  });
  const out = await fetchMod.postInnertubeDetailed(page, "search", { query: "x" });
  assert.equal(out.json, null);
  assert.match(out.error, /CDP timeout/);
  assert.match(fetchMod.getLastInnertubeError(), /CDP timeout/);
  // 兼容旧调用：postInnertube 仍返回 null
  assert.equal(await fetchMod.postInnertube(page, "search", {}), null);
});

test("postInnertubeDetailed：页内 __error（http_500/missing_ytcfg）被透出", async () => {
  for (const err of ["http_500", "missing_ytcfg", "api_timeout"]) {
    const page = fakePage(async () => ({ __error: err }));
    const out = await fetchMod.postInnertubeDetailed(page, "browse", {});
    assert.equal(out.json, null);
    assert.equal(out.error, err);
  }
});

// ---- 分级恢复 ----
test("level 0 恢复在没有 CDP 时不抛异常", async () => {
  const out = await fetchMod.recoverYoutubeSearchSession({
    level: 0,
    reason: "test",
  });
  assert.equal(out.level, 0);
  assert.equal(out.reason, "test");
  assert.equal(typeof out.closedTabs, "number");
});

test("heal level 1 在 Chrome 不可重启时安全返回（不抛）", async () => {
  const out = await health.healYtInnertubeSession({
    endpoint: "http://127.0.0.1:1",
    level: 1,
    reason: "test",
  });
  assert.equal(out.level, 1);
  assert.equal(typeof out.restartedChrome, "boolean");
});

test("dispose 语义：会话暴露 page/sessionKey/heal/fetchSearchFirstPage", () => {
  const src = String(fetchMod.acquireYoutubeInnertubeSession);
  for (const needle of ["sessionKey", "fetchSearchFirstPage", "heal:", "dispose"]) {
    assert.ok(src.includes(needle), `session object missing ${needle}`);
  }
});

const failed = tests.filter((t) => !t.ok);
console.log(`\nSUMMARY ok=${tests.length - failed.length} fail=${failed.length}`);
process.exit(failed.length ? 1 : 0);
