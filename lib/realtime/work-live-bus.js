/**
 * 工作实况事件总线：与红人画像阶段一致，payload 为 JSON 字符串（整条 SSE 事件对象）。
 * - 优先 REDIS_URL：Worker 与各 Next 实例通过 Redis Pub/Sub 对齐。
 * - 无 Redis：仅进程内订阅；Worker 须通过 POST /api/internal/work-live/push 投递。
 */

import Redis from "ioredis";

const CHANNEL_PREFIX = process.env.WORK_LIVE_CHANNEL_PREFIX || "work-live";

function channelName(sessionId) {
  return `${CHANNEL_PREFIX}:${sessionId}`;
}

/** @type {Map<string, Set<(payload: string) => void>>} */
function getMemorySubs() {
  const g = globalThis;
  if (!g.__maxinWorkLiveSubs) {
    g.__maxinWorkLiveSubs = new Map();
  }
  return g.__maxinWorkLiveSubs;
}

let redisPublisher = null;

function getRedis() {
  const url = process.env.REDIS_URL;
  if (!url) return null;
  if (!redisPublisher) {
    redisPublisher = new Redis(url, { maxRetriesPerRequest: 2 });
  }
  return redisPublisher;
}

/**
 * @param {string} sessionId
 * @param {object} event - 将 JSON.stringify 后写入 SSE：`data: ${JSON.stringify(event)}\n\n`
 */
export function publishWorkLiveEvent(sessionId, event) {
  const payload = JSON.stringify(event);
  const ch = channelName(sessionId);
  const r = getRedis();
  if (r) {
    r.publish(ch, payload).catch(() => {});
    return;
  }
  const subs = getMemorySubs().get(sessionId);
  if (subs) {
    for (const fn of subs) {
      try {
        fn(payload);
      } catch {
        // ignore subscriber errors
      }
    }
  }
}

/**
 * @param {string} sessionId
 * @param {(payload: string) => void} onPayload - JSON 字符串
 * @returns {() => void} unsubscribe
 */
export function subscribeWorkLive(sessionId, onPayload) {
  const url = process.env.REDIS_URL;
  if (url) {
    const redisSub = new Redis(url, { maxRetriesPerRequest: 2 });
    const ch = channelName(sessionId);
    redisSub.subscribe(ch).catch(() => {});
    redisSub.on("message", (receivedChannel, message) => {
      if (receivedChannel === ch) {
        onPayload(message);
      }
    });
    return () => {
      try {
        redisSub.disconnect();
      } catch {
        // ignore
      }
    };
  }

  const map = getMemorySubs();
  if (!map.has(sessionId)) {
    map.set(sessionId, new Set());
  }
  map.get(sessionId).add(onPayload);

  return () => {
    const set = map.get(sessionId);
    if (set) {
      set.delete(onPayload);
      if (set.size === 0) {
        map.delete(sessionId);
      }
    }
  };
}
