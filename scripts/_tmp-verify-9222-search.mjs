#!/usr/bin/env node
/**
 * 验证 9222 综合搜索是否恢复：bootstrap + general/full(count=5)。
 * ok=true 且 videos>0 说明不再被 2483/空结果拦截。
 */
import { admissionCheckTikTok } from "../lib/ops/tiktok-session-manager.js";

const r = await admissionCheckTikTok("http://127.0.0.1:9222", {
  proxyPort: 7897,
  keyword: "student",
  count: 5,
  timeoutMs: 60000,
});
console.log("ADMISSION", JSON.stringify(r));
process.exit(r.ok && Number(r.videos) > 0 ? 0 : 1);
