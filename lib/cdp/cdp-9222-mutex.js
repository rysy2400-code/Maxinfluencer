/**
 * CDP_9222_MODE=serial 时：全局 FIFO 互斥（非 192.65 或回滚用）。
 */

let locked = false;
/** @type {Array<{ resolve: () => void, reject: (e: Error) => void, meta: object, timer?: ReturnType<typeof setTimeout> }>} */
const waitQueue = [];

function lockTimeoutMs() {
  const n = Number(process.env.CDP_9222_LOCK_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 ? n : 300_000;
}

function logLock(msg, meta = {}) {
  if (String(process.env.CDP_9222_LOCK_LOG || "true").toLowerCase() === "false") return;
  const parts = [
    msg,
    meta.platform ? `platform=${meta.platform}` : "",
    meta.taskId != null ? `taskId=${meta.taskId}` : "",
    meta.phase ? `phase=${meta.phase}` : "",
  ].filter(Boolean);
  console.log(`[cdp-9222-mutex] ${parts.join(" ")}`);
}

/**
 * @param {object} meta
 * @param {() => Promise<unknown>} fn
 */
export async function withCdp9222Lock(meta, fn) {
  const waitStart = Date.now();
  await acquireCdp9222Lock(meta);
  const waitMs = Date.now() - waitStart;
  if (waitMs > 500) logLock(`acquired waitMs=${waitMs}`, meta);
  try {
    return await fn();
  } finally {
    releaseCdp9222Lock();
  }
}

function acquireCdp9222Lock(meta) {
  if (!locked) {
    locked = true;
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const entry = { resolve, reject, meta };
    const ms = lockTimeoutMs();
    entry.timer = setTimeout(() => {
      const i = waitQueue.indexOf(entry);
      if (i >= 0) waitQueue.splice(i, 1);
      reject(
        new Error(
          `cdp_9222_lock_timeout after ${ms}ms platform=${meta.platform || "?"} phase=${meta.phase || "?"}`
        )
      );
    }, ms);
    waitQueue.push(entry);
    logLock(`queued depth=${waitQueue.length}`, meta);
  });
}

function releaseCdp9222Lock() {
  const next = waitQueue.shift();
  if (next) {
    if (next.timer) clearTimeout(next.timer);
    next.resolve();
  } else {
    locked = false;
  }
}
