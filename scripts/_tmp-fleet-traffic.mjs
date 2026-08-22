#!/usr/bin/env node
/**
 * 本机（任一 crawler）执行：读取 4 个 mihomo 控制器累计流量（downloadTotal+uploadTotal）
 */
const CONTROLLERS = [
  { cdp: 9222, ctrl: 9090 },
  { cdp: 9223, ctrl: 9108 },
  { cdp: 9224, ctrl: 9109 },
  { cdp: 9225, ctrl: 9110 },
];
const out = [];
for (const c of CONTROLLERS) {
  let total = null;
  try {
    const res = await fetch(`http://127.0.0.1:${c.ctrl}/connections`, {
      signal: AbortSignal.timeout(4000),
    });
    const j = await res.json();
    total = (Number(j.downloadTotal) || 0) + (Number(j.uploadTotal) || 0);
  } catch {
    total = null;
  }
  out.push(`${c.cdp}=${total == null ? "ERR" : (total / 1048576).toFixed(2)}MB`);
}
console.log(`TRAFFIC ${new Date().toISOString()} ${out.join(" ")}`);
process.exit(0);
