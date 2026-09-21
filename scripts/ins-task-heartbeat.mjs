/**
 * 独立任务心跳：只要本机 worker 进程还活着，就把本机名下 processing 任务的
 * last_progress_at 往前推，避免被「其它机器上阈值更小(7 分钟)的回收逻辑误杀」。
 * 用法：node scripts/_tmp-heartbeat-task-progress.mjs
 */
import { execSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
dotenv.config({ path: path.join(projectRoot, ".env"), quiet: true });
dotenv.config({ path: path.join(projectRoot, ".env.local"), quiet: true });

const { queryTikTok } = await import("../lib/db/mysql-tiktok.js");

function machineIp() {
  const nics = os.networkInterfaces();
  for (const list of Object.values(nics)) {
    for (const n of list || []) {
      if (n.family === "IPv4" && !n.internal && String(n.address).startsWith("10.61.")) {
        return n.address;
      }
    }
  }
  return null;
}

function workerAlive() {
  try {
    const out = execSync(
      'powershell -NoProfile -Command "(Get-CimInstance Win32_Process | Where-Object { $_.Name -eq \'node.exe\' -and $_.CommandLine -match \'worker-influencer-search\' } | Measure-Object).Count"',
      { encoding: "utf8", timeout: 20000 }
    );
    return Number(String(out).trim()) > 0;
  } catch {
    return false;
  }
}

async function main() {
  const ip = machineIp();
  if (!ip) return;
  if (!workerAlive()) {
    console.log("worker not running, skip heartbeat");
    return;
  }
  const r1 = await queryTikTok(
    `UPDATE tiktok_influencer_search_task
     SET last_progress_at = NOW()
     WHERE status = 'processing' AND worker_ip = ?`,
    [ip]
  );
  const r2 = await queryTikTok(
    `UPDATE tiktok_influencer_import_task
     SET last_progress_at = NOW()
     WHERE status = 'processing' AND worker_ip = ?`,
    [ip]
  );
  console.log(
    `heartbeat ip=${ip} search=${Number(r1?.affectedRows || 0)} import=${Number(r2?.affectedRows || 0)}`
  );
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("heartbeat failed:", e?.message || e);
    process.exit(1);
  });
