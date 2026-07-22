export const CRAWLER_LEVELS = ["fault", "degraded", "normal", "idle", "unknown"];

const DEFAULTS = {
  heartbeatTimeoutMs: 120_000,
  claimDegradedMs: 5 * 60_000,
  claimFaultMs: 10 * 60_000,
  minimumRateSample: 5,
  degradedSuccessRate: 0.5,
  faultSuccessRate: 0.2,
  degradedConsecutiveFailures: 3,
  faultConsecutiveFailures: 5,
};

function timeMs(value) {
  if (!value) return 0;
  const n = new Date(value).getTime();
  return Number.isFinite(n) ? n : 0;
}

function boolOrNull(value) {
  if (value == null) return null;
  return value === true || Number(value) === 1;
}

function pushReason(reasons, code, level, detail = null) {
  reasons.push({ code, level, detail });
}

export function normalizeExecutionWindow(raw = {}) {
  const succeeded = Number(raw.succeeded || 0);
  const invalidSucceeded = Math.min(
    succeeded,
    Number(raw.invalidSucceeded || raw.invalid_succeeded || 0)
  );
  const failed = Number(raw.failed || 0);
  const effectiveSucceeded = Math.max(0, succeeded - invalidSucceeded);
  const completed = succeeded + failed;
  return {
    claimed: Number(raw.claimed || 0),
    processing: Number(raw.processing || 0),
    succeeded,
    invalidSucceeded,
    effectiveSucceeded,
    failed,
    completed,
    effectiveSuccessRate: completed > 0 ? effectiveSucceeded / completed : null,
    consecutiveFailures: Number(raw.consecutiveFailures || 0),
    p50DurationSeconds:
      raw.p50DurationSeconds == null ? null : Number(raw.p50DurationSeconds),
    p95DurationSeconds:
      raw.p95DurationSeconds == null ? null : Number(raw.p95DurationSeconds),
  };
}

/**
 * Compute an explainable machine-platform state from raw health, queue and task metrics.
 * The function is intentionally pure so UI, alerting and auto-repair use identical rules.
 */
export function evaluateCrawlerOperationalHealth(input = {}, options = {}) {
  const cfg = { ...DEFAULTS, ...options };
  const nowMs = timeMs(input.now) || Date.now();
  const health = input.health || null;
  const tenMinutes = normalizeExecutionWindow(input.tenMinutes);
  const oneHour = normalizeExecutionWindow(input.oneHour);
  const queue = {
    pending: Number(input.queue?.pending || 0),
    oldestPendingAt: input.queue?.oldestPendingAt || null,
  };
  const reasons = [];

  if (!health) {
    return { level: "unknown", reasonCodes: ["HEALTH_MISSING"], reasons, tenMinutes, oneHour };
  }

  const lastSeenMs = timeMs(health.lastSeenAt);
  if (!lastSeenMs || nowMs - lastSeenMs > cfg.heartbeatTimeoutMs) {
    pushReason(reasons, "HEARTBEAT_STALE", "fault", { lastSeenAt: health.lastSeenAt || null });
  }
  if (boolOrNull(health.workerAlive) === false) {
    pushReason(reasons, "WORKER_NOT_ALIVE", "fault");
  }
  if (boolOrNull(health.workerLoopOk) === false) {
    pushReason(reasons, "WORKER_LOOP_STALLED", "fault");
  }
  const cdpRpcOk = boolOrNull(health.cdpRpcOk);
  const cdpUnavailable =
    cdpRpcOk === false || (cdpRpcOk == null && boolOrNull(health.cdpHttpOk) === false);
  if (cdpUnavailable && Number(health.cdpRpcFailStreak || 0) >= 3) {
    pushReason(reasons, "CDP_RPC_UNAVAILABLE", "fault", {
      failStreak: Number(health.cdpRpcFailStreak || 0),
    });
  }
  if (input.roleDrift === true) {
    pushReason(reasons, "PLATFORM_ROLE_DRIFT", "degraded", {
      expected: input.platform || null,
      reported: health.reportedPlatforms || [],
    });
  }

  const timeoutMinutes = Math.max(1, Number(input.taskTimeoutMinutes || 30));
  if (Number(input.staleProcessingCount || 0) > 0) {
    pushReason(reasons, "PROCESSING_TIMEOUT", "fault", { timeoutMinutes });
  }

  const lastActivityMs = Math.max(
    timeMs(input.lastClaimAt || health.lastClaimAt),
    timeMs(input.lastProgressAt || health.lastProgressAt)
  );
  if (queue.pending > 0) {
    const inactivityMs = lastActivityMs ? nowMs - lastActivityMs : Number.POSITIVE_INFINITY;
    const queueAgeMs = queue.oldestPendingAt
      ? nowMs - timeMs(queue.oldestPendingAt)
      : 0;
    if (queueAgeMs >= cfg.claimFaultMs && inactivityMs >= cfg.claimFaultMs) {
      pushReason(reasons, "QUEUE_NOT_CONSUMED", "fault", { inactivityMs });
    } else if (queueAgeMs >= cfg.claimDegradedMs && inactivityMs >= cfg.claimDegradedMs) {
      pushReason(reasons, "QUEUE_CONSUMPTION_SLOW", "degraded", { inactivityMs });
    }
  }

  if (tenMinutes.consecutiveFailures >= cfg.faultConsecutiveFailures) {
    pushReason(reasons, "CONSECUTIVE_FAILURES", "fault", {
      count: tenMinutes.consecutiveFailures,
    });
  } else if (tenMinutes.consecutiveFailures >= cfg.degradedConsecutiveFailures) {
    pushReason(reasons, "CONSECUTIVE_FAILURES", "degraded", {
      count: tenMinutes.consecutiveFailures,
    });
  }

  if (tenMinutes.completed >= cfg.minimumRateSample) {
    if (tenMinutes.effectiveSuccessRate < cfg.faultSuccessRate) {
      pushReason(reasons, "EFFECTIVE_SUCCESS_RATE_CRITICAL", "fault", {
        rate: tenMinutes.effectiveSuccessRate,
      });
    } else if (tenMinutes.effectiveSuccessRate < cfg.degradedSuccessRate) {
      pushReason(reasons, "EFFECTIVE_SUCCESS_RATE_LOW", "degraded", {
        rate: tenMinutes.effectiveSuccessRate,
      });
    }
  }
  if (tenMinutes.invalidSucceeded > 0) {
    pushReason(reasons, "INVALID_SUCCEEDED", "degraded", {
      count: tenMinutes.invalidSucceeded,
    });
  }

  let level = "normal";
  if (reasons.some((reason) => reason.level === "fault")) level = "fault";
  else if (reasons.some((reason) => reason.level === "degraded")) level = "degraded";
  else if (queue.pending === 0 && tenMinutes.processing === 0 && tenMinutes.claimed === 0) {
    level = "idle";
  }

  return {
    level,
    reasonCodes: reasons.map((reason) => reason.code),
    reasons,
    tenMinutes,
    oneHour,
  };
}
