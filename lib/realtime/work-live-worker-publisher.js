/**
 * 供 scripts/worker-influencer-search.js（Node ESM）调用：
 * - 若配置 REDIS_URL：直接 PUBLISH（与 Web SSE 订阅同频道）。
 * - 否则 POST 到 Next 的 /api/internal/work-live/push（需 WORK_LIVE_PUSH_URL + WORK_LIVE_PUSH_SECRET）。
 */
import Redis from "ioredis";

const PREFIX = process.env.WORK_LIVE_CHANNEL_PREFIX || "work-live";

function channelFor(sessionId) {
  return `${PREFIX}:${sessionId}`;
}

let redisClient = null;

function getRedisPublish() {
  const url = process.env.REDIS_URL;
  if (!url) return null;
  if (!redisClient) {
    redisClient = new Redis(url, { maxRetriesPerRequest: 2 });
  }
  return redisClient;
}

/**
 * @param {string} sessionId
 * @param {object} event - { type: 'thinking'|'screenshot'|..., data? }
 */
export async function publishWorkLiveFromWorker(sessionId, event) {
  const payload = JSON.stringify(event);
  const r = getRedisPublish();
  if (r) {
    await r.publish(channelFor(sessionId), payload);
    return;
  }

  const base =
    process.env.WORK_LIVE_PUSH_URL ||
    process.env.NEXT_PUBLIC_APP_URL ||
    process.env.APP_URL;
  const secret = process.env.WORK_LIVE_PUSH_SECRET;
  if (!base || !secret) {
    return;
  }
  const url = `${base.replace(/\/$/, "")}/api/internal/work-live/push`;
  await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-work-live-secret": secret,
    },
    body: JSON.stringify({ sessionId, event }),
  });
}
