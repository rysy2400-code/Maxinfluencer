/**
 * 手动运行一次汇报心跳（用于本地测试）
 *
 * 使用方式：
 *   node scripts/run-report-heartbeat-once.js
 */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import { runReportHeartbeatTick } from "../lib/heartbeat/report-heartbeat.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
dotenv.config({ path: path.join(projectRoot, ".env") });
dotenv.config({ path: path.join(projectRoot, ".env.local") });

async function main() {
  const now = new Date();
  await runReportHeartbeatTick(now);
}

main().catch((err) => {
  console.error("❌ 汇报心跳执行失败:", err);
  process.exit(1);
});

