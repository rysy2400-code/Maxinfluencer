#!/usr/bin/env node
import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
dotenv.config({ path: path.join(root, ".env"), quiet: true });
dotenv.config({ path: path.join(root, ".env.local"), quiet: true });
const { queryTikTok, tiktokPool } = await import("../lib/db/mysql-tiktok.js");

const platform = String(process.argv[2] || "").trim().toLowerCase();
if (!["youtube", "tiktok", "instagram", "x"].includes(platform)) {
  console.error("usage: node scripts/list-crawler-deploy-targets.mjs <youtube|tiktok|instagram|x>");
  process.exit(2);
}

try {
  const rows = await queryTikTok(
    `SELECT m.machine_key, m.ssh_host, r.release_sha
     FROM tiktok_crawler_machine m
     JOIN tiktok_crawler_machine_platform mp ON mp.machine_id=m.id
     LEFT JOIN tiktok_crawler_release r ON r.platform=mp.platform AND r.status='active'
     WHERE m.enabled=1 AND mp.enabled=1 AND mp.platform=?
     ORDER BY m.id`,
    [platform]
  );
  if (!rows?.length) throw new Error(`数据库中没有启用的 ${platform} crawler`);
  const releaseSha = String(rows[0].release_sha || "").trim().toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(releaseSha)) {
    throw new Error(`${platform} 尚未配置 active production release`);
  }
  console.log(`CRAWLER_RELEASE=${releaseSha}`);
  for (const row of rows) {
    const key = String(row.machine_key || "").trim();
    const host = String(row.ssh_host || "").trim();
    if (!/^[a-zA-Z0-9.-]+$/.test(key) || !/^[a-zA-Z0-9.-]+$/.test(host)) {
      throw new Error(`非法 crawler target: ${key} / ${host}`);
    }
    if (String(row.release_sha || "").trim().toLowerCase() !== releaseSha) {
      throw new Error(`${platform} 存在不一致的 active release`);
    }
    console.log(`CRAWLER_TARGET=${key}=${host}`);
  }
} finally {
  await tiktokPool.end();
}
