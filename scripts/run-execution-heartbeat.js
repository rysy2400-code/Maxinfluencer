/**
 * 执行侧心跳入口脚本。
 *
 * 用途：
 * - 供 cron / systemd 定时调用：
 *     node scripts/run-execution-heartbeat.js
 * - 内部调用 lib/heartbeat/execution-heartbeat.js 中的 runExecutionHeartbeatTick。
 */

import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import { runExecutionHeartbeatTick } from "../lib/heartbeat/execution-heartbeat.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");

// 加载环境变量（.env 再 .env.local）
dotenv.config({ path: path.join(projectRoot, ".env") });
dotenv.config({ path: path.join(projectRoot, ".env.local") });

async function main() {
  const now = new Date();
  console.log(
    "[run-execution-heartbeat] 开始一次执行侧心跳 tick，时间：",
    now.toISOString()
  );
  await runExecutionHeartbeatTick(now);
  console.log("[run-execution-heartbeat] 本次执行侧心跳完成。");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("[run-execution-heartbeat] 运行出错：", err?.message || err);
    process.exit(1);
  });

