#!/usr/bin/env node
/**
 * 执行心跳「平台关键词并行规划 + 统一入队」逻辑的单元测试。
 *
 * 用法：node scripts/test-execution-heartbeat-parallel-dispatch.mjs
 *
 * 不访问生产 DB / 不调用真实 LLM：planPlatform 与 enqueue 全部注入 mock。
 */

import assert from "node:assert/strict";
import { dispatchPlatformKeywordTasks } from "../lib/heartbeat/execution-heartbeat.js";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function ok(name, detail = "") {
  console.log(`✅ ${name}${detail ? `: ${detail}` : ""}`);
}

function makeCampaign(id = "CAMP-TEST") {
  return {
    id,
    sessionId: "SES-TEST",
    influencersPerDay: 5,
    productInfo: { productName: "test product" },
  };
}

// ---------------------------------------------------------------------------
// 1) 并行：多个平台规划应同时进行，且各自拿到独立去重快照
// ---------------------------------------------------------------------------
{
  let active = 0;
  let maxActive = 0;
  let plannedSnapshots = [];

  const plansByPlatform = {
    tiktok: [
      { keyword: "pool robot", keywordType: "new", reasonText: "a" },
      { keyword: "Pool Robot", keywordType: "variant", reasonText: "b" }, // 同平台大小写重复，应去重
      { keyword: "robot review", keywordType: "new", reasonText: "c" },
    ],
    instagram: [
      { keyword: "#poolrobot", keywordType: "new", reasonText: "d" },
      { keyword: "#poolrobot", keywordType: "new", reasonText: "e" }, // 同平台重复，应去重
    ],
    youtube: [{ keyword: "best pool robot review", keywordType: "new", reasonText: "f" }],
  };

  const enqueued = [];
  const existingKeywords = new Set(["already-run-keyword"]);

  const result = await dispatchPlatformKeywordTasks({
    campaign: makeCampaign(),
    runId: "CAMP-TEST-20260809",
    needed: 3,
    existingKeywords,
    planTargets: Object.keys(plansByPlatform),
    maxParallel: 100,
    planPlatform: async (_campaign, snapshot, platformSlug) => {
      plannedSnapshots.push(snapshot);
      active += 1;
      maxActive = Math.max(maxActive, active);
      await sleep(40);
      active -= 1;
      return plansByPlatform[platformSlug];
    },
    enqueue: async (payload) => {
      await sleep(5);
      enqueued.push(payload);
    },
  });

  assert.equal(maxActive, 3, `3 个平台应并发规划，实际 maxActive=${maxActive}`);
  assert.equal(result.enqueued, 4, "去重后应入队 3+1+1 共 4 条（tiktok 去重 1 条，instagram 去重 1 条）");
  assert.equal(result.failed, 0);
  assert.equal(enqueued.length, 4);

  const perPlatform = new Map();
  for (const e of enqueued) {
    const list = perPlatform.get(e.platform) || [];
    list.push(e.keywordPlan.keyword);
    perPlatform.set(e.platform, list);
  }
  assert.deepEqual(perPlatform.get("tiktok"), ["pool robot", "robot review"]);
  assert.deepEqual(perPlatform.get("instagram"), ["#poolrobot"]);
  assert.deepEqual(perPlatform.get("youtube"), ["best pool robot review"]);

  // 每个平台应拿到独立 Set 快照（互不共享引用）
  const uniqueSnapshots = new Set(plannedSnapshots);
  assert.equal(uniqueSnapshots.size, 3, "各平台应使用独立 Set 快照");
  assert.ok(plannedSnapshots.every((s) => s.has("already-run-keyword")));
  // 入队关键词应回填到 existingKeywords，供同 tick 后续去重
  assert.ok(existingKeywords.has("pool robot"));
  assert.ok(existingKeywords.has("best pool robot review"));

  ok("并行规划", `maxActive=${maxActive}，3 平台同时生成`);
  ok("按平台去重入队", `enqueued=${result.enqueued}，重复关键词被跳过`);
}

// ---------------------------------------------------------------------------
// 2) 错误隔离：单个平台规划失败，不影响其它平台
// ---------------------------------------------------------------------------
{
  const enqueued = [];
  const result = await dispatchPlatformKeywordTasks({
    campaign: makeCampaign("CAMP-ERR"),
    runId: "CAMP-ERR-20260809",
    needed: 2,
    existingKeywords: new Set(),
    planTargets: ["tiktok", "instagram", "youtube"],
    maxParallel: 100,
    planPlatform: async (_c, _s, platformSlug) => {
      await sleep(10);
      if (platformSlug === "instagram") throw new Error("mock LLM 失败");
      return [{ keyword: `${platformSlug}-kw`, keywordType: "new", reasonText: "" }];
    },
    enqueue: async (payload) => enqueued.push(payload),
  });

  assert.equal(result.failed, 1, "应记录 1 个失败平台");
  assert.equal(result.enqueued, 2, "其余 2 平台应正常入队");
  assert.equal(enqueued.length, 2);
  ok("失败平台隔离", "instagram 失败未阻塞 tiktok/youtube 派单");
}

// ---------------------------------------------------------------------------
// 3) 并发上限：maxParallel=1 时严格串行
// ---------------------------------------------------------------------------
{
  let active = 0;
  let maxActive = 0;
  const result = await dispatchPlatformKeywordTasks({
    campaign: makeCampaign("CAMP-SERIAL"),
    runId: "CAMP-SERIAL-20260809",
    needed: 1,
    existingKeywords: new Set(),
    planTargets: ["tiktok", "instagram", "youtube"],
    maxParallel: 1,
    planPlatform: async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await sleep(10);
      active -= 1;
      return [{ keyword: "k", keywordType: "new", reasonText: "" }];
    },
    enqueue: async () => {},
  });
  assert.equal(maxActive, 1, "maxParallel=1 时应串行");
  assert.equal(result.enqueued, 3);
  ok("并发上限生效", "maxParallel=1 时 maxActive=1");
}

// ---------------------------------------------------------------------------
// 4) 空平台列表：直接返回，不入队
// ---------------------------------------------------------------------------
{
  const result = await dispatchPlatformKeywordTasks({
    campaign: makeCampaign("CAMP-EMPTY"),
    runId: "CAMP-EMPTY-20260809",
    needed: 1,
    existingKeywords: new Set(),
    planTargets: [],
    enqueue: async () => {
      throw new Error("空列表不应调用 enqueue");
    },
  });
  assert.deepEqual(result, { enqueued: 0, failed: 0 });
  ok("空平台列表短路", "返回 0/0");
}

console.log("\n✅ execution-heartbeat 并行派单单元测试全部通过");
