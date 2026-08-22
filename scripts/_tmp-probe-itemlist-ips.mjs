#!/usr/bin/env node
/**
 * 探测 4 个端口的当前出口 IP 及 item_list 数据可用性：
 * 用 WorkBuddy 名单中此前成功的红人试拉首条视频（count=1）。
 */
import dotenv from "dotenv";
dotenv.config({ path: "C:\\maxinfluencer\\.env.local" });
dotenv.config({ path: "C:\\maxinfluencer\\.env" });
const { acquireTiktokApiSession, fetchFirstRepresentativeVideoForUser } = await import(
  "../lib/tools/influencer-functions/tiktok/tiktok-direct-fetch.js"
);
const { getProxyIp } = await import("../lib/ops/tiktok-session-manager.js");

const PORTS = [
  { cdp: 9222, proxy: 7897 },
  { cdp: 9223, proxy: 7898 },
  { cdp: 9224, proxy: 7899 },
  { cdp: 9225, proxy: 7900 },
];
const HANDLES = ["markaspusatguriang", "bigw_soundrenaline", "wilianto_se"];

for (const p of PORTS) {
  let ip = null;
  try {
    ip = await getProxyIp(p.proxy);
  } catch {
    ip = "ERR";
  }
  const results = [];
  for (const h of HANDLES) {
    let session = null;
    try {
      session = await acquireTiktokApiSession(null, {
        endpointKey: `http://127.0.0.1:${p.cdp}`,
        forceNewTab: true,
      });
      const probe = await fetchFirstRepresentativeVideoForUser(session.page, h);
      results.push(`${h}=${probe.videoId ? "OK" : "EMPTY"}${probe.error ? `(${String(probe.error).slice(0, 60)})` : ""}`);
    } catch (e) {
      results.push(`${h}=ERR(${String(e?.message || e).slice(0, 60)})`);
    } finally {
      try {
        await session?.dispose?.();
      } catch {
        /* ignore */
      }
    }
  }
  console.log(`PORT ${p.cdp} ip=${ip} | ${results.join(" | ")}`);
}
process.exit(0);
