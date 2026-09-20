/**
 * 通用：查看 / 重试 tiktok_influencer_agent_event 里 failed 的事件。
 *
 * 只做「failed → pending」的重置，实际发信由常驻 worker 消费完成。
 * 默认 dry-run，只有 --apply 才写库；可选 --require-smtp 在 SMTP 探活通过后才重置，
 * 避免在没有网络时反复空转。
 *
 * 用法：
 *   node scripts/retry-failed-influencer-events.mjs                        # 列出最近 failed
 *   node scripts/retry-failed-influencer-events.mjs --campaign=CAMP-xxx
 *   node scripts/retry-failed-influencer-events.mjs --event-type=send_contract_email
 *   node scripts/retry-failed-influencer-events.mjs --ids=70943,70944,70983
 *   node scripts/retry-failed-influencer-events.mjs --ids=70943,70944,70983 --apply --require-smtp
 */
import net from "net";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

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

function probeTcp(host, port = 587, timeoutMs = 6000) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;
    const done = (ok, reason) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve({ host, ok, reason });
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => done(true, null));
    socket.once("timeout", () => done(false, "timeout"));
    socket.once("error", (e) => done(false, e?.code || e?.message));
    socket.connect(port, host);
  });
}

function buildWhere() {
  const where = ["status = 'failed'"];
  const params = [];

  const ids = String(argValue("ids", ""))
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n) && n > 0);
  if (ids.length) {
    where.push(`id IN (${ids.map(() => "?").join(",")})`);
    params.push(...ids);
  }
  const eventType = argValue("event-type");
  if (eventType) {
    where.push("event_type = ?");
    params.push(eventType);
  }
  const campaignId = argValue("campaign");
  if (campaignId) {
    where.push("campaign_id = ?");
    params.push(campaignId);
  }
  const influencerId = argValue("influencer");
  if (influencerId) {
    where.push("influencer_id = ?");
    params.push(influencerId);
  }
  const sinceHours = Number(argValue("since-hours", 0)) || 0;
  if (sinceHours > 0) {
    where.push("updated_at >= DATE_SUB(NOW(), INTERVAL ? HOUR)");
    params.push(Math.floor(sinceHours));
  }
  return { whereSql: where.join(" AND "), params };
}

async function main() {
  const apply = hasFlag("apply");
  const requireSmtp = hasFlag("require-smtp");
  const limit = Math.max(1, Math.min(2000, Number(argValue("limit", 100)) || 100));
  const smtpHost = argValue("smtp-host", "smtp.binfluencers.autos");
  const { whereSql, params } = buildWhere();

  const rows = await queryTikTok(
    `SELECT id, event_type, campaign_id, influencer_id, LEFT(error_message, 200) AS error_message, updated_at
     FROM tiktok_influencer_agent_event
     WHERE ${whereSql}
     ORDER BY updated_at DESC
     LIMIT ${limit}`,
    params
  );

  console.log(
    `[retry] failed=${rows.length} apply=${apply} requireSmtp=${requireSmtp}`
  );
  for (const row of rows) {
    console.log(
      `  #${row.id} ${row.event_type} campaign=${row.campaign_id || "-"} influencer=${row.influencer_id || "-"} at=${row.updated_at} err=${row.error_message || "-"}`
    );
  }

  if (!apply || !rows.length) {
    await tiktokPool.end?.();
    return;
  }

  if (requireSmtp) {
    const probe = await probeTcp(smtpHost, 587);
    console.log(`[retry] SMTP probe ${smtpHost}:587 -> ${JSON.stringify(probe)}`);
    if (!probe.ok) {
      console.log("[retry] SMTP 不可达，跳过重置");
      await tiktokPool.end?.();
      return;
    }
  }

  const ids = rows.map((r) => r.id);
  const result = await queryTikTok(
    `UPDATE tiktok_influencer_agent_event
     SET status = 'pending', error_message = NULL, updated_at = NOW()
     WHERE id IN (${ids.map(() => "?").join(",")}) AND status = 'failed'`,
    ids
  );
  console.log(`[retry] 已重置 failed→pending：${result.affectedRows}`);
  await tiktokPool.end?.();
}

main().catch(async (error) => {
  console.error("[retry] 失败：", error);
  try {
    await tiktokPool.end?.();
  } catch {}
  process.exitCode = 1;
});
