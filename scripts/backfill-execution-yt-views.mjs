/**
 * 回填 tiktok_campaign_execution 中 YouTube 红人缺失的播放量：
 *
 * 背景：候选/执行快照曾因 mergeInfluencerData 的 sampleCount 判定回归，
 * 将已抓到的 profile_data.statistics.avgViews 丢弃，导致：
 *  - 执行卡片“播放”显示 “—”
 *  - eCPM = flatFee / (avgViews/1000) 因缺 views 无法计算
 *  - 但画像分析正文仍引用了真实平均播放量
 *
 * 数据来源优先级：
 *  1. tiktok_influencer.profile_data.statistics.avgViews（按 influencer_id）
 *  2. 同一 campaign 候选表 tiktok_campaign_influencer_candidates 快照 views
 *
 * 同时回填 tiktok_influencer.avg_views / views_display。
 *
 * 用法：
 *   node scripts/backfill-execution-yt-views.mjs --dry-run
 *   node scripts/backfill-execution-yt-views.mjs
 */
import mysql from "mysql2/promise";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
dotenv.config({ path: path.join(projectRoot, ".env.local"), quiet: true });

const DRY_RUN = process.argv.includes("--dry-run");

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

function viewStatsOf(pd) {
  const avg = Number(pd?.statistics?.avgViews);
  if (!Number.isFinite(avg) || avg <= 0) return null;
  return { avg: Math.round(avg), display: formatNumber(avg) };
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

  console.log(`${DRY_RUN ? "[dry-run] " : ""}开始扫描执行表 YT views 缺失行...`);
  const [rows] = await conn.query(
    `SELECT id, campaign_id, tiktok_username, influencer_id, stage, influencer_snapshot
     FROM tiktok_campaign_execution`
  );
  console.log(`执行行总数：${rows.length}`);

  const missing = [];
  for (const r of rows) {
    const s = parseJson(r.influencer_snapshot) || {};
    if (!isYoutubeSnapshot(s) || !hasMissingViews(s)) continue;
    missing.push({ row: r, snapshot: s });
  }
  console.log(`其中 YT 且 views 缺失：${missing.length}`);
  if (!missing.length) {
    await conn.end();
    return;
  }

  const byStage = missing.reduce((m, x) => {
    const k = x.row.stage || "(empty)";
    m[k] = (m[k] || 0) + 1;
    return m;
  }, {});
  console.log(`按 stage：${JSON.stringify(byStage)}`);

  // 加载 tiktok_influencer profile_data.statistics.avgViews
  const infMap = new Map();
  const ids = [
    ...new Set(
      missing
        .map((x) => String(x.row.influencer_id || ""))
        .filter(Boolean)
    ),
  ];
  for (let i = 0; i < ids.length; i += 300) {
    const chunk = ids.slice(i, i + 300);
    const [infRows] = await conn.query(
      `SELECT influencer_id, avg_views, views_display, profile_data
       FROM TikTok_influencer
       WHERE influencer_id IN (${chunk.map(() => "?").join(",")})`,
      chunk
    );
    for (const r of infRows) infMap.set(`id:${r.influencer_id}`, r);
  }
  const noId = missing.filter((x) => !x.row.influencer_id);
  const unames = [...new Set(noId.map((x) => String(x.row.tiktok_username || "")))];
  for (let i = 0; i < unames.length; i += 300) {
    const chunk = unames.slice(i, i + 300);
    const [infRows] = await conn.query(
      `SELECT influencer_id, avg_views, views_display, profile_data
       FROM TikTok_influencer
       WHERE username IN (${chunk.map(() => "?").join(",")})`,
      chunk
    );
    for (const r of infRows) infMap.set(`u:${r.username}`, r);
  }

  const execUpdates = [];
  const infUpdates = new Map();
  const noSource = [];

  for (const { row, snapshot } of missing) {
    const key = row.influencer_id
      ? `id:${row.influencer_id}`
      : `u:${row.tiktok_username}`;
    const inf = infMap.get(key);
    let views = viewStatsOf(parseJson(inf?.profile_data) || {});
    let from = "profile_data";

    if (!views) {
      // 兜底：同一 campaign 候选表里可能已有修复后的 views
      const [cand] = await conn.query(
        `SELECT influencer_snapshot
         FROM tiktok_campaign_influencer_candidates
         WHERE campaign_id = ? AND LOWER(tiktok_username) = LOWER(?)
         LIMIT 1`,
        [row.campaign_id, row.tiktok_username]
      );
      const candSnap = parseJson(cand?.[0]?.influencer_snapshot) || {};
      const cv = candSnap?.views;
      if (
        cv &&
        typeof cv === "object" &&
        Number.isFinite(Number(cv?.avg)) &&
        Number(cv.avg) > 0
      ) {
        views = { avg: Math.round(Number(cv.avg)), display: formatNumber(cv.avg) };
        from = "candidate_snapshot";
      }
    }

    if (!views) {
      noSource.push(row.tiktok_username);
      continue;
    }

    execUpdates.push({ row, views, from });
    if (inf?.influencer_id) {
      const curAvg = Number(inf.avg_views);
      const curDisplay = String(inf.views_display || "");
      if (
        (!Number.isFinite(curAvg) || curAvg <= 0 || !curDisplay || curDisplay === "0") &&
        from === "profile_data"
      ) {
        infUpdates.set(String(inf.influencer_id), {
          avg_views: views.avg,
          views_display: views.display,
        });
      }
    }
  }

  console.log(
    `待更新执行行 ${execUpdates.length}，可回填全局 influencer ${infUpdates.size}，无数据源 ${noSource.length}`
  );
  if (noSource.length) {
    console.log("无数据源示例:", noSource.slice(0, 15).join(", "));
  }

  if (DRY_RUN) {
    for (const u of execUpdates.slice(0, 12)) {
      console.log(
        `  [dry-run] id=${u.row.id} @${u.row.tiktok_username} stage=${u.row.stage} -> views=${JSON.stringify(u.views)} (${u.from})`
      );
    }
    await conn.end();
    return;
  }

  const start = Date.now();
  await conn.beginTransaction();
  try {
    let updatedExec = 0;
    for (const { row, views } of execUpdates) {
      const s = parseJson(row.influencer_snapshot) || {};
      s.views = views;
      await conn.query(
        `UPDATE tiktok_campaign_execution
         SET influencer_snapshot = ?, updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [JSON.stringify(s), row.id]
      );
      updatedExec++;
    }

    let updatedInf = 0;
    for (const [influencerId, patch] of infUpdates) {
      await conn.query(
        `UPDATE TikTok_influencer
         SET avg_views = ?, views_display = ?, updated_at = CURRENT_TIMESTAMP
         WHERE influencer_id = ?`,
        [patch.avg_views, patch.views_display, influencerId]
      );
      updatedInf++;
    }
    await conn.commit();
    console.log(
      `✅ 完成：执行行 ${updatedExec}，全局 influencer ${updatedInf}，耗时 ${Date.now() - start}ms`
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
