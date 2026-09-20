/**
 * 守护：等企业发件服务器恢复后，原样重试指定的红人 Agent failed 事件。
 *
 * 背景：2026-09-20 起 smtp.binfluencers.autos / smtp.binfluencer.autos /
 * smtp.binfluencer.top 解析到的 172.237.129.108/236/242:587 全部不可达，
 * 导致已生成的补发邮件 connect ETIMEDOUT。这里只做两件事：
 *   1) 定时 TCP 探活三个 SMTP IP；
 *   2) 探活通过后把目标事件从 failed 重置为 pending，交给常驻 worker 消费；
 *      若再次失败，等下一轮探活继续重试。
 *
 * 默认 dry-run（只探活和打印，不写库），--apply 才重置事件。
 *
 * 用法：
 *   node scripts/watch-smtp-and-retry-events.mjs --events=70943,70944,70983
 *   node scripts/watch-smtp-and-retry-events.mjs --events=70943,70944,70983 --apply
 *   node scripts/watch-smtp-and-retry-events.mjs --events=70943,70944,70983 --apply \
 *     --interval-ms=60000 --timeout-ms=8000 --max-rounds=0
 *
 * --max-rounds=0 表示一直守护。
 */
import net from "net";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
dotenv.config({ path: path.join(root, ".env"), quiet: true });
dotenv.config({ path: path.join(root, ".env.local"), quiet: true });

const { queryTikTok, tiktokPool } = await import("../lib/db/mysql-tiktok.js");

const DEFAULT_SMTP_IPS = [
  "172.237.129.108",
  "172.237.129.236",
  "172.237.129.242",
];

function argValue(name, fallback = null) {
  const prefix = `--${name}=`;
  const hit = (process.argv || []).find((a) => a.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : fallback;
}

function hasFlag(name) {
  return (process.argv || []).includes(`--${name}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

function probeTcp(host, port = 587, timeoutMs = 8000) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    const started = Date.now();
    let settled = false;
    const done = (payload) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(payload);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () =>
      done({ host, port, ok: true, ms: Date.now() - started })
    );
    socket.once("timeout", () =>
      done({ host, port, ok: false, reason: "timeout", ms: Date.now() - started })
    );
    socket.once("error", (error) =>
      done({
        host,
        port,
        ok: false,
        reason: error?.code || error?.message || "error",
        ms: Date.now() - started,
      })
    );
    socket.connect(port, host);
  });
}

async function probeAll(ips, timeoutMs) {
  const results = [];
  for (const ip of ips) results.push(await probeTcp(ip, 587, timeoutMs));
  return results;
}

async function loadEvents(eventIds) {
  if (!eventIds.length) return [];
  const placeholders = eventIds.map(() => "?").join(",");
  return queryTikTok(
    `SELECT id, event_type, status, LEFT(error_message, 200) AS error_message, updated_at
     FROM tiktok_influencer_agent_event
     WHERE id IN (${placeholders})
     ORDER BY id ASC`,
    eventIds
  );
}

async function resetFailedEvents(eventIds) {
  if (!eventIds.length) return 0;
  const placeholders = eventIds.map(() => "?").join(",");
  const result = await queryTikTok(
    `UPDATE tiktok_influencer_agent_event
     SET status = 'pending', error_message = NULL, updated_at = NOW()
     WHERE id IN (${placeholders}) AND status = 'failed'`,
    eventIds
  );
  return Number(result?.affectedRows || 0);
}

async function main() {
  const apply = hasFlag("apply");
  const eventIds = String(argValue("events", ""))
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n) && n > 0);
  const ips = String(argValue("ips", DEFAULT_SMTP_IPS.join(",")))
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const intervalMs = Math.max(15000, Number(argValue("interval-ms", 60000)) || 60000);
  const timeoutMs = Math.max(2000, Number(argValue("timeout-ms", 8000)) || 8000);
  const maxRounds = Math.max(0, Number(argValue("max-rounds", 0)) || 0);
  const settleMs = Math.max(30000, Number(argValue("settle-ms", 240000)) || 240000);

  if (!eventIds.length) {
    throw new Error("缺少 --events=id1,id2,...");
  }

  log(
    `[watch] start apply=${apply} events=${eventIds.join(",")} ips=${ips.join(",")} interval=${intervalMs}ms`
  );

  let round = 0;
  while (maxRounds === 0 || round < maxRounds) {
    round += 1;
    const probes = await probeAll(ips, timeoutMs);
    const reachable = probes.filter((p) => p.ok);
    log(
      `[watch] round=${round} SMTP ${reachable.length}/${probes.length} reachable ` +
        probes.map((p) => `${p.host}:${p.ok ? "ok" : p.reason}`).join(" ")
    );

    if (!reachable.length) {
      if (maxRounds > 0 && round >= maxRounds) break;
      await sleep(intervalMs);
      continue;
    }

    const before = await loadEvents(eventIds);
    log(`[watch] events before: ${JSON.stringify(before)}`);
    if (!apply) {
      log("[watch] dry-run：探活已通过；加 --apply 才会重置事件");
      return;
    }

    const reset = await resetFailedEvents(eventIds);
    log(`[watch] reset failed→pending: ${reset}`);
    if (!reset) {
      log("[watch] 没有可重置的 failed 事件");
      return;
    }

    const deadline = Date.now() + settleMs;
    while (Date.now() < deadline) {
      await sleep(15000);
      const rows = await loadEvents(eventIds);
      const stillRunning = rows.some((r) =>
        ["pending", "processing"].includes(String(r.status))
      );
      if (!stillRunning) {
        log(`[watch] events after: ${JSON.stringify(rows)}`);
        const allOk = rows.every((r) => r.status === "succeeded");
        if (allOk) {
          log("[watch] 全部补发成功，守护退出");
          await tiktokPool.end?.();
          return;
        }
        log("[watch] 仍有失败，进入下一轮探活重试");
        break;
      }
    }

    if (maxRounds > 0 && round >= maxRounds) break;
    await sleep(intervalMs);
  }

  log("[watch] 退出（达到 max-rounds 或未满足条件）");
  await tiktokPool.end?.();
}

main().catch(async (error) => {
  console.error("[watch] 失败：", error);
  try {
    await tiktokPool.end?.();
  } catch {}
  process.exitCode = 1;
});
