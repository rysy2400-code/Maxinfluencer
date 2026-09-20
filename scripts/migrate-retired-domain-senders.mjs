/**
 * 一次性迁移：把历史线程的发件人从已退役/不可达域名切到健康域。
 *
 * 只改「线程锚点」——每个 influencer 最早的一条 bin/email 消息的 from_email，
 * 因为 resolveInfluencerThreadMailContext 正是按这一行锁定线程发件人。
 * 原始地址会写回该行 payload.originalFromEmail，可审计可回滚。
 *
 * 默认 dry-run，只有 --apply 才写库。
 *
 * 用法：
 *   node scripts/migrate-retired-domain-senders.mjs                     # 全量 dry-run
 *   node scripts/migrate-retired-domain-senders.mjs --status=running    # 只看 running campaign
 *   node scripts/migrate-retired-domain-senders.mjs --apply --batch=200 --sleep-ms=80
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import {
  RETIRED_OUTBOUND_DOMAINS,
  planRetiredSenderMigration,
} from "../lib/email/retired-sender-domains.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
dotenv.config({ path: path.join(root, ".env"), quiet: true });
dotenv.config({ path: path.join(root, ".env.local"), quiet: true });

const { queryTikTok, tiktokPool } = await import("../lib/db/mysql-tiktok.js");

function argValue(name, fallback = null) {
  const prefix = `--${name}=`;
  const hit = (process.argv || []).find((a) => a.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : fallback;
}

function hasFlag(name) {
  return (process.argv || []).includes(`--${name}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function csvEscape(value) {
  return `"${String(value ?? "").replace(/"/g, '""')}"`;
}

function writeCsv(filePath, rows) {
  const columns = [
    "message_id",
    "influencer_id",
    "campaign_id",
    "from_email",
    "to_email",
    "migrated_to",
    "reason",
    "sent_at",
  ];
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const lines = [columns.join(",")];
  for (const row of rows) {
    lines.push(columns.map((c) => csvEscape(row[c])).join(","));
  }
  fs.writeFileSync(filePath, lines.join("\n"), "utf8");
}

async function loadAnchors({ status, limit }) {
  const params = [];
  let statusJoin = "";
  if (status) {
    statusJoin = `
      INNER JOIN (
        SELECT DISTINCT e.influencer_id
        FROM tiktok_campaign_execution e
        INNER JOIN tiktok_campaign c ON c.id = e.campaign_id
        WHERE c.status = ?
      ) scope ON scope.influencer_id = a.influencer_id`;
    params.push(status);
  }
  params.push(...RETIRED_OUTBOUND_DOMAINS);
  const limitSql = limit ? `LIMIT ${Math.max(1, Number(limit) || 1)}` : "";
  return queryTikTok(
    `
    WITH anchor AS (
      SELECT
        m.id, m.influencer_id, m.campaign_id, m.from_email, m.to_email, m.subject,
        m.sent_at, m.created_at,
        ROW_NUMBER() OVER (
          PARTITION BY m.influencer_id
          ORDER BY COALESCE(m.sent_at, m.created_at) ASC, m.id ASC
        ) rn
      FROM tiktok_influencer_conversation_messages m
      WHERE m.direction = 'bin' AND m.channel = 'email'
    )
    SELECT a.id AS message_id, a.influencer_id, a.campaign_id, a.from_email,
           a.to_email, a.subject, a.sent_at, a.created_at
    FROM anchor a
    ${statusJoin}
    WHERE a.rn = 1
      AND LOWER(SUBSTRING_INDEX(a.from_email, '@', -1)) IN (${RETIRED_OUTBOUND_DOMAINS.map(() => "?").join(",")})
    ORDER BY a.id ASC
    ${limitSql}
    `,
    params
  );
}

async function main() {
  const apply = hasFlag("apply");
  const status = argValue("status");
  const limit = argValue("limit");
  const batch = Math.max(1, Number(argValue("batch", 200)) || 200);
  const sleepMs = Math.max(0, Number(argValue("sleep-ms", 80)) || 80);

  const anchors = await loadAnchors({ status, limit });
  const plans = anchors.map((row) => ({
    ...row,
    ...planRetiredSenderMigration(row.from_email),
  }));
  const changed = plans.filter((p) => p.changed);

  console.log(
    `[migrate-senders] apply=${apply} status=${status || "all"} anchors=${plans.length} toMigrate=${changed.length}`
  );

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const beforePath = path.join(
    root,
    "exports",
    `retired-sender-before-${stamp}.csv`
  );
  writeCsv(
    beforePath,
    changed.map((p) => ({
      message_id: p.message_id,
      influencer_id: p.influencer_id,
      campaign_id: p.campaign_id,
      from_email: p.from_email,
      to_email: p.to_email,
      migrated_to: p.to,
      reason: p.reason,
      sent_at: p.sent_at,
    }))
  );
  console.log(`[migrate-senders] before-image: ${beforePath}`);

  if (!apply) {
    for (const p of changed.slice(0, 15)) {
      console.log(
        `  #${p.message_id} ${p.influencer_id} ${p.from_email} -> ${p.to} (${p.reason})`
      );
    }
    await tiktokPool.end?.();
    return;
  }

  let updated = 0;
  let failed = 0;
  for (let i = 0; i < changed.length; i += 1) {
    const p = changed[i];
    try {
      await queryTikTok(
        `UPDATE tiktok_influencer_conversation_messages
         SET payload = JSON_SET(
               COALESCE(payload, JSON_OBJECT()),
               '$.originalFromEmail', ?,
               '$.senderMigrationReason', ?,
               '$.senderMigratedAt', DATE_FORMAT(NOW(), '%Y-%m-%d %H:%i:%s')
             ),
             from_email = ?
         WHERE id = ? AND LOWER(SUBSTRING_INDEX(from_email, '@', -1)) IN (${RETIRED_OUTBOUND_DOMAINS.map(() => "?").join(",")})`,
        [p.from_email, p.reason, p.to, p.message_id, ...RETIRED_OUTBOUND_DOMAINS]
      );
      updated += 1;
    } catch (error) {
      failed += 1;
      console.error(
        `[migrate-senders] 失败 #${p.message_id} ${p.from_email}:`,
        error?.message || error
      );
    }
    if ((i + 1) % batch === 0) {
      console.log(
        `[migrate-senders] 进度 ${i + 1}/${changed.length}（updated=${updated} failed=${failed}）`
      );
      if (sleepMs) await sleep(sleepMs);
    }
  }

  console.log(
    `[migrate-senders] 完成：updated=${updated} failed=${failed}`
  );
  await tiktokPool.end?.();
}

main().catch(async (error) => {
  console.error("[migrate-senders] 失败：", error);
  try {
    await tiktokPool.end?.();
  } catch {}
  process.exitCode = 1;
});
