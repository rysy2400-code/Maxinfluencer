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
// 没有 influencer_id 的行（历史脏数据）：NULL 比较会让上面所有条件变成 NULL，
// 从而既不算 healthy 也不算 conflict。这类行没有 id 可矛盾，以 profile_url 域名为准。
const HAS_ID = `(influencer_id IS NOT NULL AND influencer_id <> '')`;
const RELABEL_MATCH = `((${ID_MATCH_URL}) OR NOT ${HAS_ID})`;

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
      SUM(url_platform IS NOT NULL AND NOT ${RELABEL_MATCH}) AS conflict_cnt,
      SUM(url_platform IS NOT NULL AND ${RELABEL_MATCH} AND platform = url_platform) AS healthy_cnt,
      SUM(url_platform IS NOT NULL AND ${RELABEL_MATCH} AND (platform IS NULL OR platform <> url_platform)) AS relabel_cnt,
      SUM(NOT ${HAS_ID}) AS null_id_cnt
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
    WHERE url_platform IS NOT NULL AND NOT ${RELABEL_MATCH}
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
    WHERE url_platform IS NOT NULL AND NOT ${RELABEL_MATCH}
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

/** 导出 before-image：修复前把受影响行的原值落盘，便于回滚。 */
async function exportRelabelBeforeImage() {
  const rows = await queryTikTok(`
    SELECT id, influencer_id, username, platform, url_platform
    FROM (
      SELECT id, influencer_id, username, platform, profile_url, ${URL_PLATFORM_SQL} AS url_platform
      FROM tiktok_influencer
      WHERE profile_url IS NOT NULL
    ) t
    WHERE ${RELABEL_MATCH}
      AND (platform IS NULL OR platform <> url_platform)
  `);
  const out = path.join(root, "exports", `platform-relabel-before-${Date.now()}.csv`);
  const lines = ["id,influencer_id,username,old_platform,new_platform"];
  const esc = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  for (const r of rows || []) {
    lines.push(
      [r.id, r.influencer_id, r.username, r.platform, r.url_platform].map(esc).join(",")
    );
  }
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, lines.join("\n"), "utf8");
  return { out, rows: (rows || []).length };
}

/**
 * 只修正 relabel：id 形态与 profile_url 域名一致（或没有 id）、仅 platform 字段写错的行。
 *
 * 先一次性把候选 id 捞出来（一次全表扫描），再按平台分组、按 id 分块 UPDATE
 * （走主键）。某块撞唯一键就退化为逐行，逐行再撞就跳过并记录。
 */
async function applyRelabel({ batch, sleepMs }) {
  const rows = await queryTikTok(`
    SELECT id, url_platform FROM (
      SELECT id, influencer_id, username, platform, profile_url, ${URL_PLATFORM_SQL} AS url_platform
      FROM tiktok_influencer
    ) t
    WHERE url_platform IS NOT NULL AND ${RELABEL_MATCH}
      AND (platform IS NULL OR platform <> url_platform)
    ORDER BY id
  `);
  const byPlatform = new Map();
  for (const r of rows || []) {
    const key = String(r.url_platform);
    if (!byPlatform.has(key)) byPlatform.set(key, []);
    byPlatform.get(key).push(r.id);
  }
  let updated = 0;
  const skipped = [];
  for (const [platform, ids] of byPlatform) {
    for (let i = 0; i < ids.length; i += Number(batch)) {
      const chunk = ids.slice(i, i + Number(batch));
      const list = chunk.join(",");
      try {
        const res = await queryTikTok(
          `UPDATE tiktok_influencer t SET t.platform = ?
            WHERE t.id IN (${list}) AND profile_url IS NOT NULL
              AND (t.platform IS NULL OR t.platform <> ?)`,
          [platform, platform]
        );
        updated += Number(res?.affectedRows || 0);
      } catch (err) {
        if (err?.code !== "ER_DUP_ENTRY") throw err;
        console.warn(`[audit] ${platform} 分块 ${chunk[0]}-${chunk[chunk.length - 1]} 撞唯一键，逐行处理`);
        for (const id of chunk) {
          try {
            await queryTikTok(
              `UPDATE tiktok_influencer SET platform = ? WHERE id = ? AND (platform IS NULL OR platform <> ?)`,
              [platform, id, platform]
            );
            updated += 1;
          } catch (rowErr) {
            skipped.push({ id, target: platform });
            console.warn(`[audit] 跳过 id=${id} -> ${platform}: ${rowErr.message}`);
          }
        }
      }
      console.log(`[audit] ${platform} 已处理 ${Math.min(i + chunk.length, ids.length)}/${ids.length}，累计修正 ${updated}`);
      if (sleepMs > 0) await sleep(sleepMs);
    }
  }
  return { updated, skipped };
}

async function main() {
  const wantCsv = process.argv.includes("--csv");
  const apply = process.argv.includes("--apply");
  const batch = Number(argValue("batch", 2000));
  const sleepMs = Number(argValue("sleep-ms", 150));

  const summary = await audit();
  console.log("[audit] 主档 platform / influencer_id 审计：");
  console.log(
    `  total=${summary.total}  healthy=${summary.healthy_cnt}  relabel=${summary.relabel_cnt}  conflict=${summary.conflict_cnt}  unknown=${summary.unknown_cnt}  null_id=${summary.null_id_cnt}`
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
    const before = await exportRelabelBeforeImage();
    console.log(
      `\n[audit] before-image 已导出：${before.out}（${before.rows} 行，可用于回滚）`
    );
    console.log(`\n[audit] 开始修正 relabel（batch=${batch}, sleep=${sleepMs}ms）…`);
    const { updated, skipped } = await applyRelabel({ batch, sleepMs });
    console.log(
      `[audit] relabel 修正完成，共 ${updated} 行${skipped.length ? `，跳过 ${skipped.length} 行（撞唯一键）` : ""}`
    );
    if (skipped.length) {
      const out = path.join(root, "exports", `platform-relabel-skipped-${Date.now()}.csv`);
      fs.writeFileSync(
        out,
        ["id,influencer_id,username,target_platform", ...skipped.map((s) => `${s.id},${s.influencer_id || ""},${s.username},${s.target}`)].join("\n"),
        "utf8"
      );
      console.log(`[audit] 跳过清单：${out}`);
    }
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
