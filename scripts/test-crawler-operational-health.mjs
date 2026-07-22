import assert from "node:assert/strict";
import { evaluateCrawlerOperationalHealth } from "../lib/ops/crawler-operational-health.js";

const now = "2026-07-21T08:00:00.000Z";
const healthy = {
  lastSeenAt: "2026-07-21T07:59:30.000Z",
  workerAlive: true,
  workerLoopOk: true,
  cdpHttpOk: true,
  cdpRpcOk: true,
  cdpRpcFailStreak: 0,
  reportedPlatforms: ["youtube"],
};

function evaluate(overrides = {}) {
  return evaluateCrawlerOperationalHealth({
    now,
    platform: "youtube",
    health: healthy,
    queue: { pending: 0 },
    tenMinutes: {},
    oneHour: {},
    ...overrides,
  });
}

assert.equal(evaluate({ health: null }).level, "unknown");

const stale = evaluate({
  health: { ...healthy, lastSeenAt: "2026-07-21T07:55:00.000Z" },
});
assert.equal(stale.level, "fault");
assert.ok(stale.reasonCodes.includes("HEARTBEAT_STALE"));

assert.equal(evaluate().level, "idle");

const invalid = evaluate({
  tenMinutes: { claimed: 5, succeeded: 5, invalidSucceeded: 1, failed: 0 },
});
assert.equal(invalid.level, "degraded");
assert.ok(invalid.reasonCodes.includes("INVALID_SUCCEEDED"));

const failed = evaluate({
  tenMinutes: { claimed: 8, succeeded: 1, failed: 7, consecutiveFailures: 7 },
});
assert.equal(failed.level, "fault");
assert.ok(failed.reasonCodes.includes("EFFECTIVE_SUCCESS_RATE_CRITICAL"));
assert.ok(failed.reasonCodes.includes("CONSECUTIVE_FAILURES"));

const newQueue = evaluate({
  lastClaimAt: "2026-07-21T07:40:00.000Z",
  queue: { pending: 3, oldestPendingAt: "2026-07-21T07:59:00.000Z" },
});
assert.equal(newQueue.level, "normal");

const stalledQueue = evaluate({
  lastClaimAt: "2026-07-21T07:40:00.000Z",
  queue: { pending: 3, oldestPendingAt: "2026-07-21T07:45:00.000Z" },
});
assert.equal(stalledQueue.level, "fault");
assert.ok(stalledQueue.reasonCodes.includes("QUEUE_NOT_CONSUMED"));

const drift = evaluate({
  health: { ...healthy, reportedPlatforms: ["instagram"] },
  roleDrift: true,
  tenMinutes: { claimed: 1, succeeded: 1 },
});
assert.equal(drift.level, "degraded");
assert.ok(drift.reasonCodes.includes("PLATFORM_ROLE_DRIFT"));

console.log("crawler operational health tests passed");
