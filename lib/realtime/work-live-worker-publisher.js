/**
 * 供 scripts/worker-influencer-search.js（Node ESM）调用：
 * - 若配置 REDIS_URL：直接 PUBLISH（与 Web SSE 订阅同频道）。
 * - Redis 不可用/发布失败：回退 POST 到 Next 的 /api/internal/work-live/push
 *   （需 WORK_LIVE_PUSH_URL + WORK_LIVE_PUSH_SECRET），彻底兜底失败则仅告警。
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
    // 关键兜底：Redis 故障（如配额/限流/连接断开）时 ioredis 会 emit 'error'，
    // 不挂 listener 会变成 unhandled 'error' 直接 crash 掉 worker 进程。
    redisClient.on("error", () => {
      // 静默吞掉：work-live 只是实时广播，绝不允许影响任务消费主链路。
    });
  }
  return redisClient;
}

async function publishViaHttpPush(sessionId, event, payload) {
  const base =
    process.env.WORK_LIVE_PUSH_URL ||
    process.env.NEXT_PUBLIC_APP_URL ||
    process.env.APP_URL;
  const secret = process.env.WORK_LIVE_PUSH_SECRET;
  if (!base || !secret) {
    console.warn(
      `[work-live-worker] skip publish: Redis 不可用且未配置 WORK_LIVE_PUSH_URL (session=${sessionId}, type=${event?.type})`
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

/**
 * @param {string} sessionId
 * @param {object} event - { type: 'thinking'|'screenshot'|..., data? }
 */
export async function publishWorkLiveFromWorker(sessionId, event) {
  const payload = JSON.stringify(event);
  const r = getRedisPublish();
  if (r) {
    try {
      await r.publish(channelFor(sessionId), payload);
      return;
    } catch (e) {
      console.warn(
        `[work-live-worker] Redis publish failed session=${sessionId}:`,
        e?.message || e
      );
      // Redis 不可用时回退 HTTP push，尽量保住 Web 端工作实况。
      try {
        await publishViaHttpPush(sessionId, event, payload);
      } catch (pushErr) {
        console.warn(
          `[work-live-worker] HTTP push fallback failed session=${sessionId}:`,
          pushErr?.message || pushErr
        );
      }
      return;
    }
  }
  await publishViaHttpPush(sessionId, event, payload);
}
