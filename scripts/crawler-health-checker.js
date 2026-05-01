/**
 * 运行在控制面（建议：152.32.216.107）：
 * - 每 1 分钟检查 tiktok_crawler_worker_health + task + run_result
 * - 命中规则直接 SSH 远程执行 deploy-crawler.ps1 重部署
 * - 写 tiktok_crawler_repair_action_log 审计
 *
 * 触发规则（默认）：
 * A last_seen_at 超时 > 120s
 * B cdp_9222_ok 或 cdp_9223_ok 连续失败 >= 3（fail_streak）
 * C 同机 10 分钟内 failed 任务 >= 3
 * D 有 processing 超时 > 60min
 *
 * 限流：
 * - 同机 30 分钟最多 1 次重部署
 * - 全局 15 分钟最多 1 台重部署
 *
 * 白名单：
 * - CRAWLER_WHITELIST_IPS=ip1,ip2
 */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import os from "os";
import { execFile } from "child_process";
import { promisify } from "util";
import { queryTikTok } from "../lib/db/mysql-tiktok.js";

const execFileAsync = promisify(execFile);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
dotenv.config({ path: path.join(projectRoot, ".env") });
dotenv.config({ path: path.join(projectRoot, ".env.local") });

function nowIso() {
  return new Date().toISOString();
}

function parseList(s) {
  return String(s || "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
}

function minutesAgo(min) {
  return new Date(Date.now() - min * 60 * 1000);
}

async function logActionStart({ workerHost, workerIp, triggerReason, detail }) {
  const startedAt = new Date();
  const res = await queryTikTok(
    `
    INSERT INTO tiktok_crawler_repair_action_log (
      worker_host, worker_ip, action_type, trigger_reason, result, detail, started_at, operator
    ) VALUES (?, ?, 'redeploy_crawler', ?, 'started', ?, ?, 'auto')
  `,
    [
      workerHost,
      workerIp || null,
      triggerReason,
      detail ? String(detail).slice(0, 5000) : null,
      startedAt.toISOString().slice(0, 19).replace("T", " "),
    ]
  );
  return { id: res?.insertId || null, startedAt };
}

async function logActionFinish({ id, ok, detail }) {
  if (!id) return;
  await queryTikTok(
    `
    UPDATE tiktok_crawler_repair_action_log
    SET result = ?,
        detail = ?,
        finished_at = NOW(),
        updated_at = NOW()
    WHERE id = ?
  `,
    [ok ? "succeeded" : "failed", detail ? String(detail).slice(0, 65000) : null, id]
  );
}

async function isWhitelisted(workerIp) {
  const wl = new Set(parseList(process.env.CRAWLER_WHITELIST_IPS));
  if (wl.size === 0) return false;
  return wl.has(String(workerIp || "").trim());
}

async function rateLimitOk({ workerIp }) {
  const perMachineMinutes = Number(process.env.CRAWLER_REDEPLOY_COOLDOWN_MINUTES || 30) || 30;
  const globalMinutes = Number(process.env.CRAWLER_REDEPLOY_GLOBAL_MINUTES || 15) || 15;

  const perMachine = await queryTikTok(
    `
    SELECT COUNT(*) AS n
    FROM tiktok_crawler_repair_action_log
    WHERE action_type='redeploy_crawler'
      AND worker_ip = ?
      AND started_at >= DATE_SUB(NOW(), INTERVAL ? MINUTE)
  `,
    [workerIp, perMachineMinutes]
  );
  if (Number(perMachine?.[0]?.n || 0) > 0) return { ok: false, reason: "per_machine_cooldown" };

  const global = await queryTikTok(
    `
    SELECT COUNT(*) AS n
    FROM tiktok_crawler_repair_action_log
    WHERE action_type='redeploy_crawler'
      AND started_at >= DATE_SUB(NOW(), INTERVAL ? MINUTE)
  `,
    [globalMinutes]
  );
  if (Number(global?.[0]?.n || 0) > 0) return { ok: false, reason: "global_cooldown" };

  return { ok: true };
}

/**
 * 远程 SSH 执行爬虫机上的 deploy-crawler.ps1。
 * `CRAWLER_SSH_TIMEOUT_MS`：单次 SSH 整体超时（含 git pull / npm ci），默认 15 分钟；过短会导致误杀仍在部署中的会话。
 */
async function sshRedeploy({ workerIp }) {
  const user = String(process.env.CRAWLER_SSH_USER || "Administrator").trim();
  const port = String(process.env.CRAWLER_SSH_PORT || "22").trim();
  const defaultKeyPath = os.platform() === "win32" ? "C:/ProgramData/ssh/maxin_crawler_key" : "";
  const keyPath = String(process.env.CRAWLER_SSH_KEY_PATH || defaultKeyPath).trim();
  const timeoutMs = Math.max(30_000, Number(process.env.CRAWLER_SSH_TIMEOUT_MS || 900_000) || 900_000);

  if (!keyPath) {
    throw new Error("CRAWLER_SSH_KEY_PATH is required (set in .env.local or environment)");
  }

  const nullHosts = os.platform() === "win32" ? "NUL" : "/dev/null";

  const sshArgs = [
    "-i",
    keyPath,
    "-p",
    port,
    "-o",
    "StrictHostKeyChecking=no",
    "-o",
    `UserKnownHostsFile=${nullHosts}`,
    "-o",
    "ConnectTimeout=10",
    "-o",
    "BatchMode=yes",
    "-o",
    "ConnectionAttempts=1",
    "-o",
    "ServerAliveInterval=10",
    "-o",
    "ServerAliveCountMax=3",
    `${user}@${workerIp}`,
    "powershell",
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    "C:\\maxinfluencer\\deploy-crawler.ps1",
  ];

  const { stdout, stderr } = await execFileAsync("ssh", sshArgs, {
    timeout: timeoutMs,
    windowsHide: true,
    maxBuffer: 1024 * 1024,
  });
  return { stdout, stderr };
}

/**
 * @param {unknown} e
 * @returns {string}
 */
function formatExecError(e) {
  const parts = [String(e?.message || e)];
  if (e && typeof e === "object") {
    const o = /** @type {Record<string, unknown>} */ (e);
    if (o.code != null) parts.push(`code=${String(o.code)}`);
    if (o.signal != null) parts.push(`signal=${String(o.signal)}`);
    if (o.stdout) parts.push(`stdout:\n${String(o.stdout)}`);
    if (o.stderr) parts.push(`stderr:\n${String(o.stderr)}`);
  }
  return parts.join("\n");
}

async function waitForRecovery({ workerHost, workerIp }) {
  const deadlineMs = Date.now() + 60_000;
  while (Date.now() < deadlineMs) {
    const rows = await queryTikTok(
      `
      SELECT worker_alive, cdp_9222_ok, cdp_9223_ok, last_seen_at
      FROM tiktok_crawler_worker_health
      WHERE worker_host = ?
      LIMIT 1
    `,
      [workerHost]
    );
    const r = rows?.[0];
    if (r) {
      const last = new Date(r.last_seen_at).getTime();
      const fresh = Date.now() - last <= 60_000;
      const ok = Number(r.worker_alive || 0) === 1 && Number(r.cdp_9222_ok || 0) === 1 && Number(r.cdp_9223_ok || 0) === 1 && fresh;
      if (ok) return { ok: true };
    }
    await new Promise((x) => setTimeout(x, 5000));
  }
  return { ok: false, reason: "health_not_recovered_in_60s" };
}

async function computeTriggers({ workerHost, workerIp }) {
  const A_SEEN_TIMEOUT_SEC = Number(process.env.CRAWLER_HEALTH_TIMEOUT_SEC || 120) || 120;
  const B_CDP_FAIL_STREAK = Number(process.env.CRAWLER_CDP_FAIL_STREAK || 3) || 3;
  const C_FAIL_WINDOW_MIN = Number(process.env.CRAWLER_FAIL_WINDOW_MIN || 10) || 10;
  const C_FAIL_THRESHOLD = Number(process.env.CRAWLER_FAIL_THRESHOLD || 3) || 3;
  const D_PROCESSING_TIMEOUT_MIN = Number(process.env.CRAWLER_PROCESSING_TIMEOUT_MIN || 60) || 60;

  const healthRows = await queryTikTok(
    `
    SELECT worker_alive, cdp_9222_ok, cdp_9223_ok,
           cdp_9222_fail_streak, cdp_9223_fail_streak,
           last_seen_at
    FROM tiktok_crawler_worker_health
    WHERE worker_host = ?
    LIMIT 1
  `,
    [workerHost]
  );
  const h = healthRows?.[0];
  const triggers = [];

  if (!h) {
    triggers.push({ code: "A", reason: "health_missing" });
  } else {
    const lastSeenMs = new Date(h.last_seen_at).getTime();
    if (Date.now() - lastSeenMs > A_SEEN_TIMEOUT_SEC * 1000) {
      triggers.push({ code: "A", reason: `health_timeout>${A_SEEN_TIMEOUT_SEC}s` });
    }
    if (
      Number(h.cdp_9222_fail_streak || 0) >= B_CDP_FAIL_STREAK ||
      Number(h.cdp_9223_fail_streak || 0) >= B_CDP_FAIL_STREAK
    ) {
      triggers.push({
        code: "B",
        reason: `cdp_fail_streak(9222=${h.cdp_9222_fail_streak},9223=${h.cdp_9223_fail_streak})`,
      });
    }
  }

  const failRows = await queryTikTok(
    `
    SELECT COUNT(*) AS n
    FROM tiktok_influencer_search_task
    WHERE status = 'failed'
      AND (worker_ip = ? OR worker_host = ?)
      AND updated_at >= DATE_SUB(NOW(), INTERVAL ? MINUTE)
  `,
    [workerIp, workerHost, C_FAIL_WINDOW_MIN]
  );
  if (Number(failRows?.[0]?.n || 0) >= C_FAIL_THRESHOLD) {
    triggers.push({ code: "C", reason: `failed>=${C_FAIL_THRESHOLD} in ${C_FAIL_WINDOW_MIN}m` });
  }

  const procRows = await queryTikTok(
    `
    SELECT COUNT(*) AS n
    FROM tiktok_influencer_search_task
    WHERE status = 'processing'
      AND (worker_ip = ? OR worker_host = ?)
      AND started_at IS NOT NULL
      AND started_at < DATE_SUB(NOW(), INTERVAL ? MINUTE)
  `,
    [workerIp, workerHost, D_PROCESSING_TIMEOUT_MIN]
  );
  if (Number(procRows?.[0]?.n || 0) > 0) {
    triggers.push({ code: "D", reason: `processing_timeout>${D_PROCESSING_TIMEOUT_MIN}m` });
  }

  return triggers;
}

async function main() {
  const enable = String(process.env.AUTO_REPAIR_ENABLED || "true").toLowerCase() !== "false";
  if (!enable) {
    console.log("[crawler-health-checker] AUTO_REPAIR_ENABLED=false; exit.");
    return;
  }

  // 白名单主机：两台
  const allowHosts = new Set(parseList(process.env.CRAWLER_WHITELIST_HOSTS));
  const rows = await queryTikTok(
    `
    SELECT worker_host AS workerHost, worker_ip AS workerIp
    FROM tiktok_crawler_worker_health
  `,
    []
  );

  for (const r of rows || []) {
    const workerHost = String(r.workerHost || "").trim();
    const workerIp = String(r.workerIp || "").trim();
    if (!workerHost || !workerIp) continue;
    if (allowHosts.size > 0 && !allowHosts.has(workerHost)) continue;
    if (!(await isWhitelisted(workerIp))) continue;

    const triggers = await computeTriggers({ workerHost, workerIp });
    if (triggers.length === 0) continue;

    const rl = await rateLimitOk({ workerIp });
    if (!rl.ok) {
      await queryTikTok(
        `
        INSERT INTO tiktok_crawler_repair_action_log (
          worker_host, worker_ip, action_type, trigger_reason, result, detail, started_at, operator
        ) VALUES (?, ?, 'redeploy_crawler', ?, 'skipped', ?, NOW(), 'auto')
      `,
        [workerHost, workerIp, triggers.map((t) => `${t.code}:${t.reason}`).join("|"), rl.reason]
      );
      continue;
    }

    const triggerReason = triggers.map((t) => `${t.code}:${t.reason}`).join(" | ");
    const started = await logActionStart({
      workerHost,
      workerIp,
      triggerReason,
      detail: `auto_redeploy at ${nowIso()}`,
    });

    let ok = false;
    let detail = "";
    try {
      const out = await sshRedeploy({ workerIp });
      detail = `stdout:\n${out.stdout || ""}\n\nstderr:\n${out.stderr || ""}`;
      const rec = await waitForRecovery({ workerHost, workerIp });
      ok = Boolean(rec.ok);
      if (!ok) detail += `\n\nrecovery_check_failed: ${rec.reason || "unknown"}`;
    } catch (e) {
      ok = false;
      detail = `redeploy_error: ${formatExecError(e)}`;
    }

    await logActionFinish({ id: started.id, ok, detail });
  }
}

let _running = false;
async function tick() {
  if (_running) return;
  _running = true;
  const tickAt = nowIso();
  console.log(`[crawler-health-checker] tick start ${tickAt}`);
  try {
    await main();
    console.log(`[crawler-health-checker] tick done ${tickAt}`);
  } catch (e) {
    console.error("[crawler-health-checker] fatal:", e?.message || e);
  } finally {
    _running = false;
  }
}

// Run once immediately, then every 60s. This avoids PM2 cron restarts killing in-flight repairs.
tick();
setInterval(tick, 60_000);

