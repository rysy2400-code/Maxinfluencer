#!/usr/bin/env node
/**
 * 单次导入完成汇报扫描：执行完立即退出（供控制面计划任务每分钟调用）。
 * 不常驻，避免依赖 PM2 daemon 在 SSH 会话结束后被回收。
 */
import { reportPendingImportCompletions } from "../lib/influencer/report-import-completions.js";

try {
  const r = await reportPendingImportCompletions();
  if (r?.reportedBatch || r?.reportedSingle) {
    console.log(`[import-report-once] batch=${r.reportedBatch} single=${r.reportedSingle}`);
  }
} catch (e) {
  console.warn(`[import-report-once] tick error: ${e?.message || e}`);
}

process.exit(0);
