/**
 * Crawler 机器健康上报（部署在每台 crawler VM 上）。
 * 每 30-60s 上报一次到 crawler_worker_health：
 * - worker_host/worker_ip/worker_id
 * - worker_alive
 * - cdp_9222_ok/cdp_9223_ok + fail streak
 * - last_seen_at
 */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import { queryTikTok } from "../lib/db/mysql-tiktok.js";
import { detectPrimaryIpv4 } from "../lib/utils/net-ip.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
dotenv.config({ path: path.join(projectRoot, ".env") });
dotenv.config({ path: path.join(projectRoot, ".env.local") });

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function probe(url, timeoutMs = 2500) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(t);
  }
}

async function upsertHealth({
  workerHost,
  workerIp,
  workerId,
  alive,
  ok9222,
  ok9223,
  lastError,
}) {
  await queryTikTok(
    `
    INSERT INTO crawler_worker_health (
      worker_host,
      worker_ip,
      worker_id,
      worker_alive,
      cdp_9222_ok,
      cdp_9223_ok,
      cdp_9222_fail_streak,
      cdp_9223_fail_streak,
      last_seen_at,
      last_error
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW(), ?)
    ON DUPLICATE KEY UPDATE
      worker_ip = VALUES(worker_ip),
      worker_id = VALUES(worker_id),
      worker_alive = VALUES(worker_alive),
      cdp_9222_ok = VALUES(cdp_9222_ok),
      cdp_9223_ok = VALUES(cdp_9223_ok),
      cdp_9222_fail_streak =
        IF(VALUES(cdp_9222_ok)=1, 0, LEAST(cdp_9222_fail_streak + 1, 100000)),
      cdp_9223_fail_streak =
        IF(VALUES(cdp_9223_ok)=1, 0, LEAST(cdp_9223_fail_streak + 1, 100000)),
      last_seen_at = NOW(),
      last_error = VALUES(last_error),
      updated_at = NOW()
  `,
    [
      workerHost,
      workerIp,
      workerId,
      alive ? 1 : 0,
      ok9222 ? 1 : 0,
      ok9223 ? 1 : 0,
      ok9222 ? 0 : 1,
      ok9223 ? 0 : 1,
      lastError || null,
    ]
  );
}

async function main() {
  const loop =
    String(process.env.WORKER_HEALTH_LOOP || "true").toLowerCase() !== "false";
  const intervalMs = Math.max(
    5000,
    Number(process.env.WORKER_HEALTH_INTERVAL_MS || 30000) || 30000
  );

  const workerHost =
    String(process.env.SEARCH_WORKER_HOST || process.env.HOSTNAME || "").trim() ||
    "unknown";
  const workerId =
    String(process.env.SEARCH_WORKER_ID || "").trim() || `search-worker-${process.pid}`;
  const workerIp = detectPrimaryIpv4({ preferEnvKey: "SEARCH_WORKER_IP" });

  const url9222 =
    String(process.env.CDP_HEALTH_9222_URL || "http://127.0.0.1:9222/json/version").trim();
  const url9223 =
    String(process.env.CDP_HEALTH_9223_URL || "http://127.0.0.1:9223/json/version").trim();

  do {
    let lastError = null;
    const ok9222 = await probe(url9222);
    const ok9223 = await probe(url9223);
    if (!ok9222 || !ok9223) {
      lastError = `cdp_probe_failed(9222=${ok9222 ? "ok" : "bad"},9223=${ok9223 ? "ok" : "bad"})`;
    }

    try {
      await upsertHealth({
        workerHost,
        workerIp,
        workerId,
        alive: true,
        ok9222,
        ok9223,
        lastError,
      });
    } catch (e) {
      // DB temporarily unavailable: don't crash the worker
      // eslint-disable-next-line no-console
      console.warn("[worker-health-heartbeat] upsert failed:", e?.message || e);
    }

    if (!loop) break;
    await sleep(intervalMs);
  } while (true);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    // eslint-disable-next-line no-console
    console.error("[worker-health-heartbeat] fatal:", e?.message || e);
    process.exit(1);
  });

