#!/usr/bin/env node
/** Web 端定时汇报循环：每 60s 扫描未汇报的导入批次/单任务并生成聊天框汇报 */
import { reportPendingImportCompletions } from "../lib/influencer/report-import-completions.js";

const intervalMs = Math.max(15000, Number(process.env.IMPORT_REPORT_INTERVAL_MS || 60000));
console.log(`[import-report-loop] start interval=${intervalMs}ms`);

async function tick() {
  try {
    await reportPendingImportCompletions();
  } catch (e) {
    console.warn(`[import-report-loop] tick error: ${e?.message || e}`);
  }
}

await tick();
setInterval(tick, intervalMs);

process.on("SIGINT", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));
