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

function resolveTikTokEndpointHealthUrls() {
  const raw = String(process.env.TT_LITE_ENRICH_CDP_ENDPOINTS || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  const fallback = [
    process.env.CDP_ENDPOINT_ENRICH || "http://127.0.0.1:9223",
    process.env.TT_LITE_ENRICH_CDP,
  ]
    .map((item) => String(item || "").trim())
    .filter(Boolean);
  const endpoints = raw.length ? raw : fallback;
  return [...new Set(endpoints)].map((endpoint) => endpoint.replace(/\/+$/, ""));
}

async function evaluateCdpPage(wsUrl, expression, timeoutMs = 5000) {
  if (typeof WebSocket !== "function" || !wsUrl) return null;
  return await new Promise((resolve) => {
    let settled = false;
    let rpcTimer = null;
    const ws = new WebSocket(wsUrl);
    const done = (value) => {
      if (settled) return;
      settled = true;
      if (rpcTimer) clearTimeout(rpcTimer);
      try { ws.close(); } catch {}
      resolve(value);
    };
    rpcTimer = setTimeout(() => done(null), timeoutMs);
    ws.addEventListener("open", () => {
      ws.send(JSON.stringify({ id: 1, method: "Runtime.enable" }));
      ws.send(JSON.stringify({
        id: 2,
        method: "Runtime.evaluate",
        params: { expression, awaitPromise: true, returnByValue: true },
      }));
    });
    ws.addEventListener("message", (event) => {
      try {
        const message = JSON.parse(String(event.data || ""));
        if (message?.id === 2) {
          if (message.exceptionDetails) done(null);
          else done(message.result?.result?.value ?? null);
        }
      } catch {
        done(null);
      }
    });
    ws.addEventListener("error", () => done(null));
    ws.addEventListener("close", () => done(null));
  });
}

async function probeTikTokEndpoint(endpoint, timeoutMs = 5000) {
  const base = String(endpoint || "").replace(/\/+$/, "");
  const startedAt = Date.now();
  const out = {
    endpoint: base,
    ok: false,
    httpOk: false,
    pageOk: false,
    tiktokPageOk: false,
    pageUrl: null,
    targetId: null,
    publicIp: null,
    checkedAt: new Date().toISOString(),
    latencyMs: null,
    error: null,
  };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${base}/json/list`, { signal: ctrl.signal });
    out.httpOk = res.ok;
    if (!res.ok) throw new Error(`cdp_list_${res.status}`);
    const targets = await res.json();
    const pages = Array.isArray(targets) ? targets.filter((t) => t.type === "page") : [];
    const target =
      pages.find((t) => String(t.url || "").includes("tiktok.com") && !String(t.url || "").includes("/api/")) ||
      pages[0];
    if (!target?.webSocketDebuggerUrl) throw new Error("no_page_target");
    out.targetId = target.id || null;
    out.pageUrl = target.url || null;
    const href = await evaluateCdpPage(
      target.webSocketDebuggerUrl,
      "location.href",
      timeoutMs
    );
    const resolvedUrl = typeof href === "string" && href.length > 0 ? href : out.pageUrl;
    out.pageUrl = resolvedUrl || out.pageUrl;
    out.pageOk = typeof out.pageUrl === "string" && out.pageUrl.length > 0;
    out.tiktokPageOk = String(out.pageUrl || "").includes("tiktok.com");
    const ip = await evaluateCdpPage(
      target.webSocketDebuggerUrl,
      `(async()=>{try{const r=await fetch("${String(process.env.TT_LITE_ENDPOINT_IP_CHECK_URL || "https://api.ipify.org?format=json")}");const j=await r.json();return j.ip||j.query||null}catch(e){return null}})()`,
      timeoutMs
    );
    out.publicIp = typeof ip === "string" ? ip : null;
    out.ok = out.httpOk && out.pageOk && out.tiktokPageOk;
  } catch (e) {
    out.error = e?.message || String(e);
  } finally {
    clearTimeout(timer);
    out.latencyMs = Date.now() - startedAt;
  }
  return out;
}

async function probeTikTokEndpointHealth() {
  const platforms = String(process.env.SEARCH_WORKER_PLATFORMS || "")
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
  if (!platforms.includes("tiktok")) return [];

  const endpoints = resolveTikTokEndpointHealthUrls();
  if (!endpoints.length) return [];
  return Promise.all(endpoints.map((endpoint) => probeTikTokEndpoint(endpoint)));
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
      `SELECT id, machine_key, public_ip FROM tiktok_crawler_machine
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
      machineKey: machines?.[0]?.machine_key || machineKey || null,
      registryIp: machines?.[0]?.public_ip || workerIp || null,
      lastClaimAt: taskRows?.[0]?.last_claim_at || null,
      lastProgressAt: taskRows?.[0]?.last_progress_at || null,
    };
  } catch (error) {
    if (error?.code !== "ER_NO_SUCH_TABLE") throw error;
    return { machineId: null, machineKey: machineKey || null, registryIp: workerIp || null, lastClaimAt: null, lastProgressAt: null };
  }
}

function healthConflictTarget({ machineId, workerIp }) {
  if (machineId != null) return { where: "machine_id = ?", value: machineId };
  return { where: "worker_ip = ?", value: workerIp };
}

function formatDateOrNull(value) {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 19).replace("T", " ");
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
  tiktokEndpointHealth,
}) {
  const target = healthConflictTarget({ machineId, workerIp });
  const existingRows = await queryTikTok(
    `SELECT id FROM tiktok_crawler_worker_health WHERE ${target.where} LIMIT 1`,
    [target.value]
  );
  if (existingRows?.[0]) {
    await queryTikTok(
    `
    UPDATE tiktok_crawler_worker_health
    SET worker_host = ?,
      machine_id = ?,
      worker_ip = ?,
      worker_id = ?,
      reported_platforms = ?,
      reported_release_sha = ?,
      worker_alive = ?,
      worker_loop_ok = ?,
      cdp_9222_ok = ?,
      cdp_9222_rpc_ok = ?,
      cdp_9223_ok = ?,
      tiktok_endpoint_health = ?,
      cdp_9222_fail_streak =
        IF(COALESCE(?, ?)=1, 0, LEAST(cdp_9222_fail_streak + 1, 100000)),
      cdp_9223_fail_streak =
        IF(?=1, 0, LEAST(cdp_9223_fail_streak + 1, 100000)),
      last_seen_at = NOW(),
      last_claim_at = ?,
      last_progress_at = ?,
      last_error = ?,
      updated_at = NOW()
    WHERE ${target.where}
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
      tiktokEndpointHealth ? JSON.stringify(tiktokEndpointHealth) : null,
      rpc9222 == null ? null : rpc9222 ? 1 : 0,
      ok9222 ? 1 : 0,
      ok9223 ? 1 : 0,
      formatDateOrNull(lastClaimAt),
      formatDateOrNull(lastProgressAt),
      lastError || null,
      target.value,
    ]
  );
    return;
  }

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
      tiktok_endpoint_health,
      cdp_9222_fail_streak,
      cdp_9223_fail_streak,
      last_seen_at,
      last_claim_at,
      last_progress_at,
      last_error
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), ?, ?, ?)
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
      tiktokEndpointHealth ? JSON.stringify(tiktokEndpointHealth) : null,
      (rpc9222 ?? ok9222) ? 0 : 1,
      ok9223 ? 0 : 1,
      formatDateOrNull(lastClaimAt),
      formatDateOrNull(lastProgressAt),
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
    const tiktokEndpointHealth = await probeTikTokEndpointHealth();
    const workerLoopOk = await probeWorkerLoop();
    const runtime = await loadRuntimeIdentity(workerIp, machineKey);
    const ok9223 =
      tiktokEndpointHealth.length > 0
        ? tiktokEndpointHealth.some((item) => item.ok)
        : true;
    if (!ok9222 || rpc9222 === false || workerLoopOk === false) {
      lastError = `health_failed(http9222=${ok9222 ? "ok" : "bad"},rpc9222=${rpc9222 ? "ok" : "bad"},worker=${workerLoopOk === false ? "bad" : "ok"})`;
    } else if (tiktokEndpointHealth.length && !ok9223) {
      lastError = "tiktok_enrich_endpoints_unavailable";
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
        tiktokEndpointHealth,
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
