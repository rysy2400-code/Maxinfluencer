/**
 * 针对已 succeeded 的 first_outreach 事件，安全补写 tiktok_influencer_conversation_messages。
 *
 * 仅当满足其一才会调用 sendOutreach（不会误重发）：
 * - 执行表 last_event.outreachEmail.messageId 已存在（走 sendOutreach 内补写 + 幂等）
 * - 或对话表已有该 campaign+红人的 seed_outreach（仅幂等返回）
 *
 * 若无 last_event  outreach 且无对话行：打印 SKIP，避免可能已发信但无据时二次发信。
 *
 * 用法：
 *   node scripts/backfill-first-outreach-conversation-for-events.mjs 28 29 31 32
 */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import { queryTikTok } from "../lib/db/mysql-tiktok.js";
import { getInfluencerById } from "../lib/db/influencer-dao.js";
import { sendOutreach } from "../lib/agents/influencer-agent.js";

async function getExecutionPlatformInfluencerId(campaignId, tiktokUsername) {
  if (!campaignId || tiktokUsername == null) return null;
  const h = String(tiktokUsername).replace(/^@/, "").trim();
  if (!h) return null;
  const rows = await queryTikTok(
    `SELECT influencer_id FROM tiktok_campaign_execution
     WHERE campaign_id = ? AND tiktok_username = ? LIMIT 1`,
    [campaignId, h]
  );
  const v = rows?.[0]?.influencer_id;
  return v != null && String(v).trim() !== "" ? String(v).trim() : null;
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
dotenv.config({ path: path.join(projectRoot, ".env") });
dotenv.config({ path: path.join(projectRoot, ".env.local") });

function parseJson(value) {
  if (value == null) return null;
  if (typeof value === "object") return value;
  if (typeof value !== "string") return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function looksLikeNumericPlatformId(v) {
  return v != null && /^\d{10,}$/.test(String(v).trim());
}

async function resolvePlatformId(eventRow, payload, campaignId, tiktokUsername) {
  if (
    payload?.platformInfluencerId != null &&
    String(payload.platformInfluencerId).trim() !== ""
  ) {
    return String(payload.platformInfluencerId).trim();
  }
  const fromExec = await getExecutionPlatformInfluencerId(campaignId, tiktokUsername);
  if (fromExec) return fromExec;
  if (eventRow.influencer_id != null && String(eventRow.influencer_id).trim() !== "") {
    const ev = String(eventRow.influencer_id).trim();
    if (looksLikeNumericPlatformId(ev)) return ev;
    const main = await getInfluencerById(ev);
    if (main) return ev;
  }
  return null;
}

async function main() {
  const ids = process.argv.slice(2).map((x) => parseInt(x, 10)).filter((n) => n > 0);
  if (!ids.length) {
    console.error("用法: node scripts/backfill-first-outreach-conversation-for-events.mjs <event_id> [...]");
    process.exit(1);
  }

  for (const id of ids) {
    const rows = await queryTikTok(
      `SELECT id, influencer_id, campaign_id, event_type, status, payload FROM tiktok_influencer_agent_event WHERE id = ?`,
      [id]
    );
    const ev = rows?.[0];
    if (!ev) {
      console.warn(`[${id}] 无此事件`);
      continue;
    }
    if (ev.event_type !== "first_outreach") {
      console.warn(`[${id}] 非 first_outreach，跳过`);
      continue;
    }
    const payload = parseJson(ev.payload) || {};
    const campaignId = payload.campaignId || ev.campaign_id;
    const tiktokUsername = String(
      payload.tiktokUsername || payload.influencerId || ""
    )
      .replace(/^@/, "")
      .trim();
    if (!campaignId || !tiktokUsername) {
      console.warn(`[${id}] 缺少 campaignId / handle`);
      continue;
    }

    const platformId = await resolvePlatformId(ev, payload, campaignId, tiktokUsername);
    if (!platformId) {
      console.warn(`[${id}] 无法解析平台 influencer_id`);
      continue;
    }

    const execRows = await queryTikTok(
      `SELECT last_event FROM tiktok_campaign_execution WHERE campaign_id = ? AND tiktok_username = ? LIMIT 1`,
      [campaignId, tiktokUsername]
    );
    const lastEvent = parseJson(execRows?.[0]?.last_event) || {};
    const outreachMeta = lastEvent.outreachEmail;
    const messageId =
      outreachMeta && typeof outreachMeta.messageId === "string"
        ? outreachMeta.messageId.trim()
        : outreachMeta?.messageId != null
        ? String(outreachMeta.messageId).trim()
        : "";

    const seed = await queryTikTok(
      `SELECT id FROM tiktok_influencer_conversation_messages
       WHERE influencer_id = ? AND campaign_id = ? AND source_type = 'seed_outreach' LIMIT 1`,
      [platformId, campaignId]
    );
    if (seed?.length) {
      console.log(`[${id}] 已有 seed_outreach 对话行，跳过`);
      continue;
    }

    if (!messageId) {
      console.warn(
        `[${id}] SKIP：执行表无 last_event.outreachEmail.messageId，无法安全补写（可能已发信但无日志，勿盲目 pending 重试以免双发）。请人工核对邮箱后再决定。`
      );
      continue;
    }

    console.log(`[${id}] 调用 sendOutreach 补写/幂等 campaign=${campaignId} pid=${platformId} …`);
    try {
      const out = await sendOutreach({
        campaignId,
        platformInfluencerId: platformId,
        tiktokUsername,
        snapshot: payload.snapshot || null,
      });
      console.log(`[${id}] 完成`, out?.deduplicated ? "(deduplicated)" : "");
    } catch (e) {
      console.error(`[${id}] 失败:`, e?.message || e);
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
