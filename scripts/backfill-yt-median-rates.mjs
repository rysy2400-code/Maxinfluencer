/**
 * 回填 YouTube 红人快照缺失的「播放(中位数) / 点赞率 / 评论率」。
 *
 * 背景：线上 YTB worker 跑的 release 52522066（release/lang-e4d513c3）早于中位数/比率功能
 * （3d4241f3），profile_data.statistics 只有 avgViews/avgLikes/avgComments，
 * 候选/执行快照里没有 medianViews / likeRate / commentRate，导致前端卡片「播放(中位数)」显示「—」。
 *
 * 数据来源：tiktok_influencer.profile_data.videos 的逐条样本（views > 0 的那批），
 * 口径与 lib/influencer/video-metrics.js 的 computeViewMedianAndRates 完全一致：
 *   - medianViews = 样本播放量中位数（空样本 → null）
 *   - likeRate    = Σ点赞 / Σ播放（0~1 小数，前端 ×100 展示；Σ播放=0 → null）
 *   - commentRate = Σ评论 / Σ播放（0~1 小数）
 *
 * 写回：
 *   - tiktok_campaign_influencer_candidates.influencer_snapshot
 *   - tiktok_campaign_execution.influencer_snapshot
 *   字段：medianViews / likeRate / commentRate（顶层）+ views.median / views.medianDisplay +
 *        engagement.likeRate / engagement.commentRate
 *
 * 用法：
 *   node scripts/backfill-yt-median-rates.mjs --dry-run
 *   node scripts/backfill-yt-median-rates.mjs                      # 候选近 30 天 + 全部执行行
 *   node scripts/backfill-yt-median-rates.mjs --since=2026-09-01
 *   node scripts/backfill-yt-median-rates.mjs --since=all          # 全部历史候选
 *   node scripts/backfill-yt-median-rates.mjs --campaign=CAMP-xxx
 */
import mysql from "mysql2/promise";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import { medianNumberOf, formatCountDisplay } from "../lib/influencer/video-metrics.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
dotenv.config({ path: path.join(projectRoot, ".env") });
dotenv.config({ path: path.join(projectRoot, ".env.local"), quiet: true });

const DRY_RUN = process.argv.includes("--dry-run");
const argVal = (name) =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=").slice(1).join("=");
const SINCE_ARG = argVal("since") ?? "30d";
const CAMPAIGN = argVal("campaign") || null;
const LIMIT = Number(argVal("limit") || 0) || 0;

function parseJson(value) {
  if (value == null) return null;
  if (typeof value === "object") return value;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function toCount(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

/** 与 computeViewMedianAndRates 同口径：样本 = 播放 > 0 的视频 */
function computeMetrics(profileData) {
  const videos = Array.isArray(profileData?.videos) ? profileData.videos : [];
  const sample = videos.filter((v) => toCount(v?.views?.count) > 0);
  const views = sample.map((v) => toCount(v.views.count));
  const totalViews = views.reduce((s, n) => s + n, 0);
  const totalLikes = sample.reduce((s, v) => s + toCount(v?.likes?.count), 0);
  const totalComments = sample.reduce((s, v) => s + toCount(v?.comments?.count), 0);
  return {
    sampleCount: sample.length,
    medianViews: medianNumberOf(views),
    likeRate: totalViews > 0 ? totalLikes / totalViews : null,
    commentRate: totalViews > 0 ? totalComments / totalViews : null,
  };
}

const SNAPSHOT_JSON_SET = `
  JSON_SET(
    influencer_snapshot,
    '$.medianViews', ?,
    '$.likeRate', ?,
    '$.commentRate', ?,
    '$.views.median', ?,
    '$.views.medianDisplay', ?,
    '$.engagement.likeRate', ?,
    '$.engagement.commentRate', ?
  )`;

async function main() {
  const conn = await mysql.createConnection({
    host: process.env.MYSQL_HOST,
    port: Number(process.env.MYSQL_PORT || 3306),
    user: process.env.MYSQL_USER,
    password: process.env.MYSQL_PASSWORD,
    database: process.env.MYSQL_DATABASE,
    charset: "utf8mb4",
    connectTimeout: 10000,
  });

  const missingCond = "(influencer_snapshot->'$.medianViews') IS NULL";
  const candWhere = [`platform='youtube'`, missingCond];
  const candParams = [];
  if (CAMPAIGN) {
    candWhere.push("campaign_id = ?");
    candParams.push(CAMPAIGN);
  }
  if (SINCE_ARG !== "all") {
    const days = /^\d+d$/.test(SINCE_ARG) ? Number(SINCE_ARG.replace("d", "")) : null;
    if (days != null) {
      candWhere.push("analyzed_at >= DATE_SUB(NOW(), INTERVAL ? DAY)");
      candParams.push(days);
    } else {
      candWhere.push("analyzed_at >= ?");
      candParams.push(SINCE_ARG);
    }
  }

  console.log(
    `${DRY_RUN ? "[dry-run] " : ""}扫描 YT 候选缺失 median（since=${SINCE_ARG}${
      CAMPAIGN ? `, campaign=${CAMPAIGN}` : ""
    }）...`
  );

  // 1) 收集需要修复的行 + 涉及的 influencer_id
  const [candRows] = await conn.query(
    `SELECT id, influencer_id, tiktok_username
     FROM tiktok_campaign_influencer_candidates
     WHERE ${candWhere.join(" AND ")}`,
    candParams
  );
  const idSet = new Set();
  const unameSet = new Set();
  for (const r of candRows) {
    if (r.influencer_id) idSet.add(String(r.influencer_id));
    else if (r.tiktok_username) unameSet.add(String(r.tiktok_username));
  }
  console.log(`候选待修复行：${candRows.length}（去重 influencer_id=${idSet.size}，无ID用户名=${unameSet.size}）`);

  // 2) 执行表（全量 YT，表很小）
  const [execRows] = await conn.query(
    `SELECT id, influencer_id, tiktok_username
     FROM tiktok_campaign_execution
     WHERE platform='youtube' AND ${missingCond}${CAMPAIGN ? " AND campaign_id = ?" : ""}`,
    CAMPAIGN ? [CAMPAIGN] : []
  );
  for (const r of execRows) {
    if (r.influencer_id) idSet.add(String(r.influencer_id));
    else if (r.tiktok_username) unameSet.add(String(r.tiktok_username));
  }
  console.log(`执行待修复行：${execRows.length}（累计 influencer_id=${idSet.size}）`);

  if (idSet.size === 0 && unameSet.size === 0) {
    console.log("没有需要回填的行。");
    await conn.end();
    return;
  }

  // 3) 拉取这些红人的 profile_data.videos，计算指标
  const metrics = new Map(); // influencer_id(str) -> metrics
  const ids = [...idSet];
  for (let i = 0; i < ids.length; i += 300) {
    const chunk = ids.slice(i, i + 300);
    const [rows] = await conn.query(
      `SELECT influencer_id, profile_data FROM tiktok_influencer
       WHERE platform='youtube' AND influencer_id IN (${chunk.map(() => "?").join(",")})`,
      chunk
    );
    for (const r of rows) {
      const m = computeMetrics(parseJson(r.profile_data) || {});
      if (m.medianViews != null) metrics.set(String(r.influencer_id), m);
    }
  }
  // 无 ID 的用 username 兜底
  const metricsByUname = new Map();
  const unames = [...unameSet];
  for (let i = 0; i < unames.length; i += 300) {
    const chunk = unames.slice(i, i + 300);
    const [rows] = await conn.query(
      `SELECT username, profile_data FROM tiktok_influencer
       WHERE platform='youtube' AND username IN (${chunk.map(() => "?").join(",")})`,
      chunk
    );
    for (const r of rows) {
      const m = computeMetrics(parseJson(r.profile_data) || {});
      if (m.medianViews != null) metricsByUname.set(String(r.username), m);
    }
  }
  console.log(`可算出中位数的红人：by id=${metrics.size}，by username=${metricsByUname.size}`);

  const runUpdate = async (table, rowId, m) => {
    const p = [
      m.medianViews,
      m.likeRate,
      m.commentRate,
      m.medianViews,
      formatCountDisplay(m.medianViews),
      m.likeRate,
      m.commentRate,
    ];
    const [res] = await conn.query(
      `UPDATE ${table} SET influencer_snapshot = ${SNAPSHOT_JSON_SET}
       WHERE id = ? AND ${missingCond}`,
      [...p, rowId]
    );
    return res.affectedRows;
  };

  const targets = [
    { table: "tiktok_campaign_influencer_candidates", rows: candRows },
    { table: "tiktok_campaign_execution", rows: execRows },
  ];

  let planned = 0;
  const work = [];
  for (const { table, rows } of targets) {
    for (const r of rows) {
      const m = r.influencer_id
        ? metrics.get(String(r.influencer_id)) || metricsByUname.get(String(r.tiktok_username))
        : metricsByUname.get(String(r.tiktok_username));
      if (!m) continue;
      work.push({ table, id: r.id, m });
      planned += 1;
      if (LIMIT && planned >= LIMIT) break;
    }
    if (LIMIT && planned >= LIMIT) break;
  }
  console.log(`计划更新 ${planned} 行`);

  if (DRY_RUN) {
    for (const w of work.slice(0, 10)) {
      console.log(
        `  [dry-run] ${w.table} id=${w.id} -> medianViews=${w.m.medianViews} likeRate=${w.m.likeRate?.toFixed(5)} commentRate=${w.m.commentRate?.toFixed(5)}`
      );
    }
    await conn.end();
    return;
  }

  let updated = 0;
  const start = Date.now();
  for (const w of work) {
    updated += await runUpdate(w.table, w.id, w.m);
    if (updated % 2000 === 0 && updated > 0) {
      console.log(`  ...已更新 ${updated} 行（${((Date.now() - start) / 1000).toFixed(0)}s）`);
    }
  }
  console.log(`✅ 完成：计划 ${planned} 行，实际更新 ${updated} 行，耗时 ${((Date.now() - start) / 1000).toFixed(0)}s`);
  await conn.end();
}

main().catch((e) => {
  console.error("回填失败:", e);
  process.exit(1);
});
