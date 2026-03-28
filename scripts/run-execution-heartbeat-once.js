#!/usr/bin/env node
import { runExecutionHeartbeatTick } from "../lib/heartbeat/execution-heartbeat.js";

/**
 * 手动触发一次执行侧心跳：
 * - 模拟「今天」跑一轮「每天联系 N 位红人」的编排逻辑
 * - 当前版本不会真正找红人，只会根据占位候选池逻辑输出日志
 *
 * 使用方式：
 *   node scripts/run-execution-heartbeat-once.js
 */

async function main() {
  const now = new Date();
  console.log(
    "[ExecutionHeartbeat] 手动触发一次执行心跳，时间：",
    now.toISOString()
  );
  await runExecutionHeartbeatTick(now);
  process.exit(0);
}

main().catch((err) => {
  console.error("[ExecutionHeartbeat] 运行失败:", err);
  process.exit(1);
});

