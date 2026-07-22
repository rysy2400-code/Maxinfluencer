/**
 * Crawler 机器健康上报（部署在每台 crawler VM 上）。
 * 每 30-60s 上报一次到 tiktok_crawler_worker_health：
 * - worker_host/worker_ip/worker_id
 * - worker_alive
 * - cdp_9222_ok + fail streak（9223 已下线，DB 字段保留并固定上报 ok）
 * - last_seen_at
 */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import { queryTikTok } from "../lib/db/mysql-tiktok.js";
import { detectPrimaryIpv4 } from "../lib/utils/net-ip.js";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

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

async function probeCdpRpc(url, timeoutMs = 4000) {
  if (typeof WebSocket !== "function") return null;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) return false;
    const json = await res.json();
    const wsUrl = json?.webSocketDebuggerUrl;
    if (!wsUrl) return false;
    return await new Promise((resolve) => {
      let settled = false;
      const ws = new WebSocket(wsUrl);
      const done = (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(rpcTimer);
        try { ws.close(); } catch {}
        resolve(value);
      };
      const rpcTimer = setTimeout(() => done(false), timeoutMs);
      ws.addEventListener("open", () => {
        ws.send(JSON.stringify({ id: 1, method: "Browser.getVersion" }));
      });
      ws.addEventListener("message", (event) => {
        try {
          const message = JSON.parse(String(event.data || ""));
          if (message?.id === 1 && message?.result?.product) done(true);
        } catch {}
      });
      ws.addEventListener("error", () => done(false));
      ws.addEventListener("close", () => done(false));
    });
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function probeWorkerLoop() {
  if (process.platform !== "win32") return null;
  try {
    const { stdout } = await execFileAsync(
      "powershell.exe",
      [
        "-NoProfile",
        "-Command",
        "@(Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -match 'worker-influencer-search\\.js' }).Count",
      ],
      { timeout: 5000, windowsHide: true }
    );
    return Number(String(stdout || "").trim()) > 0;
  } catch {
    return false;
  }
}

function currentReleaseSha() {
  const fromEnv = String(process.env.CRAWLER_DEPLOY_SHA || "").trim();
  if (/^[0-9a-f]{40}$/i.test(fromEnv)) return fromEnv.toLowerCase();
  try {
    return String(
      execFileSync("git", ["-C", projectRoot, "rev-parse", "HEAD"], {
        encoding: "utf8",
        timeout: 3000,
        windowsHide: true,
      })
    ).trim();
  } catch {
    return null;
  }
}

async function loadRuntimeIdentity(workerIp, machineKey) {
  try {
    const machines = await queryTikTok(
      `SELECT id FROM tiktok_crawler_machine
       WHERE enabled=1 AND (machine_key=? OR (?='' AND public_ip=?))
       ORDER BY (machine_key=?) DESC LIMIT 1`,
      [machineKey, machineKey, workerIp, machineKey]
    );
    const taskRows = await queryTikTok(
      `SELECT MAX(started_at) AS last_claim_at, MAX(last_progress_at) AS last_progress_at
       FROM tiktok_influencer_search_task WHERE worker_ip=?`,
      [workerIp]
    );
    return {
      machineId: machines?.[0]?.id == null ? null : Number(machines[0].id),
      lastClaimAt: taskRows?.[0]?.last_claim_at || null,
      lastProgressAt: taskRows?.[0]?.last_progress_at || null,
    };
  } catch (error) {
    if (error?.code !== "ER_NO_SUCH_TABLE") throw error;
    return { machineId: null, lastClaimAt: null, lastProgressAt: null };
  }
}

async function upsertHealth({
  workerHost,
  workerIp,
  workerId,
  alive,
  ok9222,
  rpc9222,
  workerLoopOk,
  ok9223,
  machineId,
  reportedPlatforms,
  reportedReleaseSha,
  lastClaimAt,
  lastProgressAt,
  lastError,
}) {
  await queryTikTok(
    `
    INSERT INTO tiktok_crawler_worker_health (
      worker_host,
      machine_id,
      worker_ip,
      worker_id,
      reported_platforms,
      reported_release_sha,
      worker_alive,
      worker_loop_ok,
      cdp_9222_ok,
      cdp_9222_rpc_ok,
      cdp_9223_ok,
      cdp_9222_fail_streak,
      cdp_9223_fail_streak,
      last_seen_at,
      last_claim_at,
      last_progress_at,
      last_error
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), ?, ?, ?)
    ON DUPLICATE KEY UPDATE
      machine_id = VALUES(machine_id),
      worker_ip = VALUES(worker_ip),
      worker_id = VALUES(worker_id),
      reported_platforms = VALUES(reported_platforms),
      reported_release_sha = VALUES(reported_release_sha),
      worker_alive = VALUES(worker_alive),
      worker_loop_ok = VALUES(worker_loop_ok),
      cdp_9222_ok = VALUES(cdp_9222_ok),
      cdp_9222_rpc_ok = VALUES(cdp_9222_rpc_ok),
      cdp_9223_ok = VALUES(cdp_9223_ok),
      cdp_9222_fail_streak =
        IF(COALESCE(VALUES(cdp_9222_rpc_ok), VALUES(cdp_9222_ok))=1, 0, LEAST(cdp_9222_fail_streak + 1, 100000)),
      cdp_9223_fail_streak =
        IF(VALUES(cdp_9223_ok)=1, 0, LEAST(cdp_9223_fail_streak + 1, 100000)),
      last_seen_at = NOW(),
      last_claim_at = VALUES(last_claim_at),
      last_progress_at = VALUES(last_progress_at),
      last_error = VALUES(last_error),
      updated_at = NOW()
  `,
    [
      workerHost,
      machineId,
      workerIp,
      workerId,
      reportedPlatforms || null,
      reportedReleaseSha || null,
      alive ? 1 : 0,
      workerLoopOk == null ? null : workerLoopOk ? 1 : 0,
      ok9222 ? 1 : 0,
      rpc9222 == null ? null : rpc9222 ? 1 : 0,
      ok9223 ? 1 : 0,
      (rpc9222 ?? ok9222) ? 0 : 1,
      ok9223 ? 0 : 1,
      lastClaimAt,
      lastProgressAt,
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
  const reportedPlatforms = String(process.env.SEARCH_WORKER_PLATFORMS || "")
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean)
    .join(",");
  const reportedReleaseSha = currentReleaseSha();
  const machineKey = String(process.env.CRAWLER_MACHINE_KEY || "").trim();

  const url9222 =
    String(process.env.CDP_HEALTH_9222_URL || "http://127.0.0.1:9222/json/version").trim();

  do {
    let lastError = null;
    const ok9222 = await probe(url9222);
    const rpc9222 = ok9222 ? await probeCdpRpc(url9222) : false;
    const workerLoopOk = await probeWorkerLoop();
    const runtime = await loadRuntimeIdentity(workerIp, machineKey);
    const ok9223 = true;
    if (!ok9222 || rpc9222 === false || workerLoopOk === false) {
      lastError = `health_failed(http9222=${ok9222 ? "ok" : "bad"},rpc9222=${rpc9222 ? "ok" : "bad"},worker=${workerLoopOk === false ? "bad" : "ok"})`;
    }

    try {
      await upsertHealth({
        workerHost,
        workerIp,
        workerId,
        alive: true,
        ok9222,
        rpc9222,
        workerLoopOk,
        ok9223,
        machineId: runtime.machineId,
        reportedPlatforms,
        reportedReleaseSha,
        lastClaimAt: runtime.lastClaimAt,
        lastProgressAt: runtime.lastProgressAt,
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
