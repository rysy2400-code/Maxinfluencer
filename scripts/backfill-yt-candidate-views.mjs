/**
 * 回填 YouTube 候选快照缺失的 views：
 *
 * 背景：mergeInfluencerData 曾把“有播放样本”判定为 statistics.sampleCount > 0，
 * 但 YT/IG/TikTok 不返回 sampleCount，导致已抓到的 statistics.avgViews 未写入
 * mergedRecord.views，候选表 influencer_snapshot.views 为 null，前端卡片播放显示 “—”。
 *
 * 本脚本从 tiktok_influencer.profile_data.statistics.avgViews 恢复：
 *  - tiktok_campaign_influencer_candidates.influencer_snapshot.views
 *  - tiktok_influencer.avg_views / views_display
 *
 * 用法：
 *   node scripts/backfill-yt-candidate-views.mjs --dry-run
 *   node scripts/backfill-yt-candidate-views.mjs
 */
import mysql from "mysql2/promise";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
dotenv.config({ path: path.join(projectRoot, ".env.local") });

const DRY_RUN = process.argv.includes("--dry-run");
const SINCE = process.argv.find((a) => a.startsWith("--since="))?.split("=")[1] || "2026-09-06 00:00:00";
const CAMPAIGN_IDS = [
  // 近一周仍在跑 YT 搜索/分析且有候选的 campaign
  "CAMP-1788895759773-I05R52PFY",
  "CAMP-1788185757377-6C7T46L7R",
];

function parseJson(value) {
  if (value == null) return null;
  if (typeof value === "object") return value;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function formatNumber(num) {
  const n = Number(num);
  if (!Number.isFinite(n)) return "0";
  if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
  return String(Math.round(n));
}

function isYoutubeSnapshot(s) {
  return (
    String(s?.platform || "").toLowerCase().includes("youtube") ||
    String(s?.profileUrl || "").toLowerCase().includes("youtube.com") ||
    String(s?.profileUrl || "").toLowerCase().includes("youtu.be")
  );
}

function hasMissingViews(s) {
  const v = s?.views;
  if (v == null || v === "") return true;
  if (typeof v === "object") {
    return !(Number.isFinite(Number(v?.avg)) && Number(v.avg) > 0);
  }
  const n = Number(v);
  return !Number.isFinite(n) || n <= 0;
}

async function main() {
  const conn = await mysql.createConnection({
    host: process.env.MYSQL_HOST,
    port: Number(process.env.MYSQL_PORT || 3306),
    user: process.env.MYSQL_USER,
    password: process.env.MYSQL_PASSWORD,
    database: process.env.MYSQL_DATABASE,
    connectTimeout: 10000,
  });

  console.log(
    `${DRY_RUN ? "[dry-run] " : ""}开始回填 YT views，since=${SINCE}`
  );

  const allRows = [];
  for (const campaignId of CAMPAIGN_IDS) {
    const [rows] = await conn.query(
      `SELECT id, campaign_id, tiktok_username, influencer_id, analyzed_at, influencer_snapshot
       FROM tiktok_campaign_influencer_candidates
       WHERE campaign_id = ?
         AND match_analysis IS NOT NULL
         AND analyzed_at >= ?
       ORDER BY id`,
      [campaignId, SINCE]
    );
    console.log(`campaign=${campaignId} 候选 ${rows.length} 行`);
    allRows.push(...rows);
  }

  const candidates = [];
  for (const r of allRows) {
    const s = parseJson(r.influencer_snapshot) || {};
    if (!isYoutubeSnapshot(s) || !hasMissingViews(s)) continue;
    candidates.push({ row: r, snapshot: s });
  }
  console.log(`其中 YT 且 views 缺失：${candidates.length}`);
  if (!candidates.length) {
    await conn.end();
    return;
  }

  // 加载 tiktok_influencer（优先 influencer_id；没有 ID 的用 username 精确匹配兜底）
  const infMap = new Map();
  const byId = [
    ...new Set(
      candidates.map((x) => String(x.row.influencer_id || "")).filter(Boolean)
    ),
  ];
  for (let i = 0; i < byId.length; i += 150) {
    const chunk = byId.slice(i, i + 150);
    const [rows] = await conn.query(
      `SELECT influencer_id, username, avg_views, views_display, profile_data
       FROM TikTok_influencer
       WHERE influencer_id IN (${chunk.map(() => "?").join(",")})`,
      chunk
    );
    for (const r of rows) infMap.set(`id:${r.influencer_id}`, r);
  }

  const missingId = candidates.filter((x) => !x.row.influencer_id);
  const byUsername = [
    ...new Set(missingId.map((x) => String(x.row.tiktok_username || ""))),
  ];
  for (let i = 0; i < byUsername.length; i += 150) {
    const chunk = byUsername.slice(i, i + 150);
    const [rows] = await conn.query(
      `SELECT influencer_id, username, avg_views, views_display, profile_data
       FROM TikTok_influencer
       WHERE username IN (${chunk.map(() => "?").join(",")})`,
      chunk
    );
    for (const r of rows) infMap.set(`u:${r.username}`, r);
  }

  const candidateUpdates = [];
  const influencerUpdates = new Map();

  for (const { row, snapshot } of candidates) {
    const key = row.influencer_id ? `id:${row.influencer_id}` : `u:${row.tiktok_username}`;
    const inf = infMap.get(key);
    const pd = parseJson(inf?.profile_data) || {};
    const avgRaw = Number(pd?.statistics?.avgViews);
    if (!Number.isFinite(avgRaw) || avgRaw <= 0) {
      console.log(
        `  跳过（无可用 profile_data.statistics.avgViews）@${row.tiktok_username}`
      );
      continue;
    }
    const avg = Math.round(avgRaw);
    const views = { avg, display: formatNumber(avg) };
    candidateUpdates.push({ row, views });

    const curAvg = Number(inf?.avg_views);
    const curDisplay = String(inf?.views_display || "");
    if (
      inf?.influencer_id &&
      (!Number.isFinite(curAvg) || curAvg <= 0 || !curDisplay || curDisplay === "0")
    ) {
      influencerUpdates.set(String(inf.influencer_id), {
        avg_views: avg,
        views_display: views.display,
      });
    }
  }

  console.log(`待更新候选 ${candidateUpdates.length} 行，全局 influencer ${influencerUpdates.size} 行`);
  if (DRY_RUN) {
    for (const { row, views } of candidateUpdates.slice(0, 10)) {
      console.log(`  [dry-run] @${row.tiktok_username} -> views=${JSON.stringify(views)}`);
    }
    await conn.end();
    return;
  }

  const begin = Date.now();
  await conn.beginTransaction();
  try {
    let updatedCandidates = 0;
    for (const { row, views } of candidateUpdates) {
      const s = parseJson(row.influencer_snapshot) || {};
      s.views = views;
      await conn.query(
        `UPDATE tiktok_campaign_influencer_candidates
         SET influencer_snapshot = ?, updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [JSON.stringify(s), row.id]
      );
      updatedCandidates++;
    }

    let updatedInfluencers = 0;
    for (const [influencerId, patch] of influencerUpdates) {
      await conn.query(
        `UPDATE TikTok_influencer
         SET avg_views = ?, views_display = ?, updated_at = CURRENT_TIMESTAMP
         WHERE influencer_id = ?`,
        [patch.avg_views, patch.views_display, influencerId]
      );
      updatedInfluencers++;
    }
    await conn.commit();
    console.log(
      `✅ 完成：候选 ${updatedCandidates} 行，全局 influencer ${updatedInfluencers} 行，耗时 ${Date.now() - begin}ms`
    );
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    await conn.end();
  }
}

main().catch((e) => {
  console.error("回填失败:", e);
  process.exit(1);
});
