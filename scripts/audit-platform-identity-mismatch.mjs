/**
 * 主档 platform / influencer_id 错配审计与修复。
 *
 * 背景：旧唯一键是 username 全局唯一，同一个 @handle 在多个平台各有一份资料时
 * 会被合并成一行，导致 platform 字段和 influencer_id 互相错配（例如
 * platform='tiktok' 但 influencer_id 是 UC 开头的 YouTube id，全表 7 万+ 行）。
 *
 * 判定依据：
 * - profile_url 的域名是"这行资料属于哪个平台"最可靠的信号；
 * - id 形态只能区分 YouTube（UC...）与数字（TikTok / Instagram / X 无法仅凭数字区分）。
 *
 * 分类：
 *   healthy  : platform 与 profile_url 域名一致，且 id 形态与之一致
 *   relabel  : id 形态与 profile_url 域名一致，只是 platform 字段写错 → 可直接改标签
 *   conflict : id 形态与 profile_url 域名矛盾（一行里混了两个平台）→ 不能靠改标签修
 *   unknown  : profile_url 域名识别不出平台 → 不动，等重抓
 *
 * 用法：
 *   node scripts/audit-platform-identity-mismatch.mjs                  # 只读审计
 *   node scripts/audit-platform-identity-mismatch.mjs --csv            # 额外导出 conflict 清单
 *   node scripts/audit-platform-identity-mismatch.mjs --apply          # 修正 relabel（分批）
 *   node scripts/audit-platform-identity-mismatch.mjs --apply --batch 2000 --sleep-ms 200
 */
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import dotenv from "dotenv";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
dotenv.config({ path: path.join(root, ".env"), quiet: true });
dotenv.config({ path: path.join(root, ".env.local"), quiet: true });

const { queryTikTok, tiktokPool } = await import("../lib/db/mysql-tiktok.js");

// profile_url → 平台 slug；识别不出给 NULL
const URL_PLATFORM_SQL = `
  CASE
    WHEN profile_url LIKE '%tiktok.com%' THEN 'tiktok'
    WHEN profile_url LIKE '%instagram.com%' THEN 'instagram'
    WHEN profile_url LIKE '%youtube.com%' OR profile_url LIKE '%youtu.be%' THEN 'youtube'
    WHEN profile_url LIKE '%x.com%' OR profile_url LIKE '%twitter.com%' THEN 'x'
    ELSE NULL
  END
`;

// 分类条件
const IS_YT_ID = `(influencer_id LIKE 'UC%')`;
const URL_YT = `(url_platform = 'youtube')`;
const URL_NON_YT = `(url_platform IN ('tiktok','instagram','x'))`;
const ID_MATCH_URL = `((${URL_YT} AND ${IS_YT_ID}) OR (${URL_NON_YT} AND NOT ${IS_YT_ID}))`;

function argValue(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function audit() {
  const rows = await queryTikTok(`
    SELECT
      COUNT(*) AS total,
      SUM(url_platform IS NULL) AS unknown_cnt,
      SUM(url_platform IS NOT NULL AND NOT ${ID_MATCH_URL}) AS conflict_cnt,
      SUM(url_platform IS NOT NULL AND ${ID_MATCH_URL} AND platform = url_platform) AS healthy_cnt,
      SUM(url_platform IS NOT NULL AND ${ID_MATCH_URL} AND (platform IS NULL OR platform <> url_platform)) AS relabel_cnt
    FROM (
      SELECT influencer_id, platform, LOWER(platform) AS platform_lc, ${URL_PLATFORM_SQL} AS url_platform
      FROM tiktok_influencer
    ) t
  `);
  return rows?.[0] || {};
}

async function breakdown() {
  return queryTikTok(`
    SELECT platform AS stored_platform, url_platform, id_shape, COUNT(*) AS c
    FROM (
      SELECT
        platform,
        ${URL_PLATFORM_SQL} AS url_platform,
        CASE WHEN influencer_id LIKE 'UC%' THEN 'youtube_id' ELSE 'numeric_id' END AS id_shape
      FROM tiktok_influencer
    ) t
    WHERE url_platform IS NOT NULL
    GROUP BY stored_platform, url_platform, id_shape
    HAVING stored_platform <> url_platform OR (url_platform = 'youtube') <> (id_shape = 'youtube_id')
    ORDER BY c DESC
    LIMIT 25
  `);
}

async function sampleConflict(limit = 15) {
  return queryTikTok(
    `
    SELECT influencer_id, platform, username, profile_url
    FROM (
      SELECT influencer_id, platform, username, profile_url, ${URL_PLATFORM_SQL} AS url_platform
      FROM tiktok_influencer
    ) t
    WHERE url_platform IS NOT NULL AND NOT ${ID_MATCH_URL}
    LIMIT ${Number(limit)}
  `
  );
}

async function exportConflictCsv(limit = 50000) {
  const rows = await queryTikTok(
    `
    SELECT influencer_id, platform, username, profile_url, followers_count, created_at
    FROM (
      SELECT influencer_id, platform, username, profile_url, followers_count, created_at, ${URL_PLATFORM_SQL} AS url_platform
      FROM tiktok_influencer
    ) t
    WHERE url_platform IS NOT NULL AND NOT ${ID_MATCH_URL}
    LIMIT ${Number(limit)}
  `
  );
  const out = path.join(root, "exports", `platform-id-conflict-${Date.now()}.csv`);
  const header = "influencer_id,stored_platform,username,profile_url,followers_count,created_at";
  const escape = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const lines = [header];
  for (const r of rows || []) {
    lines.push(
      [
        r.influencer_id,
        r.platform,
        r.username,
        r.profile_url,
        r.followers_count,
        r.created_at instanceof Date ? r.created_at.toISOString() : r.created_at,
      ]
        .map(escape)
        .join(",")
    );
  }
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, lines.join("\n"), "utf8");
  return { out, rows: (rows || []).length };
}

/** 只修正 relabel：id 形态与 profile_url 域名一致、仅 platform 字段写错的行。 */
async function applyRelabel({ batch, sleepMs }) {
  let lastId = 0;
  let updated = 0;
  for (;;) {
    const rows = await queryTikTok(
      `
      SELECT id, influencer_id, username, platform, url_platform
      FROM (
        SELECT id, influencer_id, username, platform, profile_url, ${URL_PLATFORM_SQL} AS url_platform
        FROM tiktok_influencer
        WHERE id > ? AND profile_url IS NOT NULL
      ) t
      WHERE ${ID_MATCH_URL}
        AND (platform IS NULL OR platform <> url_platform)
      ORDER BY id ASC
      LIMIT ${Number(batch)}
      `,
      [lastId]
    );
    if (!rows?.length) break;
    lastId = rows[rows.length - 1].id;

    // 逐条更新：避免批量 UPDATE 锁太久；同时逐条校验不会撞 uk_platform_username
    for (const r of rows) {
      const clash = await queryTikTok(
        `SELECT id FROM tiktok_influencer WHERE platform = ? AND username = ? AND id <> ? LIMIT 1`,
        [r.url_platform, r.username, r.id]
      );
      if (clash?.length) {
        console.warn(
          `[audit] 跳过（目标键已存在）id=${r.id} @${r.username} -> ${r.url_platform}`
        );
        continue;
      }
      await queryTikTok(`UPDATE tiktok_influencer SET platform = ? WHERE id = ?`, [
        r.url_platform,
        r.id,
      ]);
      updated += 1;
    }
    console.log(`[audit] 已处理到 id=${lastId}，累计修正 ${updated}`);
    if (sleepMs > 0) await sleep(sleepMs);
  }
  return updated;
}

async function main() {
  const wantCsv = process.argv.includes("--csv");
  const apply = process.argv.includes("--apply");
  const batch = Number(argValue("batch", 2000));
  const sleepMs = Number(argValue("sleep-ms", 150));

  const summary = await audit();
  console.log("[audit] 主档 platform / influencer_id 审计：");
  console.log(
    `  total=${summary.total}  healthy=${summary.healthy_cnt}  relabel=${summary.relabel_cnt}  conflict=${summary.conflict_cnt}  unknown=${summary.unknown_cnt}`
  );
  console.log("\n[audit] 错配明细（前 25 组）：");
  console.table(await breakdown());
  console.log("\n[audit] conflict 样本：");
  console.table(await sampleConflict());

  if (wantCsv) {
    const res = await exportConflictCsv();
    console.log(`[audit] conflict 清单已导出：${res.out}（${res.rows} 行）`);
  }

  if (apply) {
    console.log(`\n[audit] 开始修正 relabel（batch=${batch}, sleep=${sleepMs}ms）…`);
    const updated = await applyRelabel({ batch, sleepMs });
    console.log(`[audit] relabel 修正完成，共 ${updated} 行`);
    const after = await audit();
    console.log(
      `[audit] 修正后：healthy=${after.healthy_cnt} relabel=${after.relabel_cnt} conflict=${after.conflict_cnt} unknown=${after.unknown_cnt}`
    );
  } else if (!wantCsv) {
    console.log("\n[audit] 只读模式。加 --csv 导出 conflict 清单，加 --apply 修正 relabel。");
  }

  await tiktokPool.end();
}

main().catch(async (err) => {
  console.error("[audit] 运行失败:", err);
  try {
    await tiktokPool.end();
  } catch {
    /* ignore */
  }
  process.exit(1);
});
