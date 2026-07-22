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
let redisPublishDisabledReason = null;
let redisErrorWarned = false;

function shouldDisableRedisPublish(error) {
  const message = String(error?.message || error || "");
  return /max requests limit exceeded|ERR max requests limit exceeded/i.test(message);
}

function warnRedisOnce(message) {
  if (redisErrorWarned) return;
  redisErrorWarned = true;
  console.warn(`[work-live-worker] Redis publish disabled: ${message}`);
}

function getRedisPublish() {
  if (redisPublishDisabledReason) return null;
  const url = process.env.REDIS_URL;
  if (!url) return null;
  if (!redisClient) {
    redisClient = new Redis(url, { maxRetriesPerRequest: 2 });
    redisClient.on("error", (e) => {
      if (shouldDisableRedisPublish(e)) {
        redisPublishDisabledReason = e?.message || "redis publish quota exceeded";
        warnRedisOnce(redisPublishDisabledReason);
      }
    });
  }
  return redisClient;
}

/**
 * @param {string} sessionId
 * @param {object} event - { type: 'thinking'|'screenshot'|..., data? }
 */
export async function publishWorkLiveFromWorker(sessionId, event) {
  if (process.env.WORK_LIVE_DISABLE_PUBLISH === "1") return;
  if (redisPublishDisabledReason) return;
  const payload = JSON.stringify(event);
  const r = getRedisPublish();
  if (r) {
    try {
      await r.publish(channelFor(sessionId), payload);
    } catch (e) {
      if (shouldDisableRedisPublish(e)) {
        redisPublishDisabledReason = e?.message || "redis publish quota exceeded";
        warnRedisOnce(redisPublishDisabledReason);
        return;
      }
      warnRedisOnce(`session=${sessionId}: ${e?.message || e}`);
    }
    return;
  }

  const base =
    process.env.WORK_LIVE_PUSH_URL ||
    process.env.NEXT_PUBLIC_APP_URL ||
    process.env.APP_URL;
  const secret = process.env.WORK_LIVE_PUSH_SECRET;
  if (!base || !secret) {
    console.warn(
      `[work-live-worker] skip publish: no REDIS_URL and no WORK_LIVE_PUSH_URL (session=${sessionId}, type=${event?.type})`
    );
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
