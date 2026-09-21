#!/usr/bin/env node
/**
 * 存量候选回填：bio 语言 + accountCountry（默认只处理 TikTok 候选行）。
 *
 * 背景：候选快照（tiktok_campaign_influencer_candidates.influencer_snapshot）在 2026-09-21 之前
 * 只写 videoPublishCountry、不写 bioLanguage/accountCountry，导致前端卡片「注册国家 / 语言」显示 -。
 * 新版本已双写这两个字段，本脚本把存量行补齐，让历史卡片同样有值。
 *
 * 三段：
 *   A. 语言旁路表补齐：按 influencer_id 取主页 bio 推断语言写入 tiktok_influencer_language
 *      （只补 bio_language 为空的行，不覆盖已有值；推导不出语言就跳过）
 *   B. 候选快照补 accountCountry / account_country：与 videoPublishCountry 同源，
 *      缺失时回退主档 TikTok_influencer.video_publish_country / country
 *   C. 候选快照补 bioLanguage / bioLanguageConfidence / bioLanguageSource：来自旁路表
 *
 * 用法（默认 dry-run，不写库）：
 *   node --experimental-default-type=module scripts/backfill-candidate-bio-language-country.mjs
 *   node --experimental-default-type=module scripts/backfill-candidate-bio-language-country.mjs --apply
 * 可选参数：
 *   --platform=tiktok|all   默认 tiktok
 *   --batch=5000            每批处理行数
 *   --sleep=150             每批之间休眠毫秒数（降压）
 *   --limit=N               最多处理 N 行（调试用，0=不限）
 *   --only=A|B|C            只跑某一段
 */
import { queryTikTok } from "../lib/db/mysql-tiktok.js";
import { detectBioLanguageProfile } from "../lib/influencer/infer-bio-language.js";

const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const argOf = (name, dflt) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split("=").slice(1).join("=") : dflt;
};
const PLATFORM = String(argOf("platform", "tiktok")).toLowerCase();
const BATCH = Math.max(100, Number(argOf("batch", 5000)) || 5000);
const SLEEP = Math.max(0, Number(argOf("sleep", 150)) || 0);
const LIMIT = Math.max(0, Number(argOf("limit", 0)) || 0);
const ONLY = String(argOf("only", "")).toUpperCase();
const want = (seg) => !ONLY || ONLY.includes(seg);

const PLATFORM_SQL =
  PLATFORM === "all" ? "1=1" : "LOWER(COALESCE(c.platform,'')) = ?";
const platformParams = (extra = []) =>
  PLATFORM === "all" ? extra : extra.concat([PLATFORM]);

const sleep = (ms) => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : null);
const fmt = (n) => Number(n || 0).toLocaleString("en-US");
const log = (...a) => console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...a);

log(
  `start apply=${APPLY} platform=${PLATFORM} batch=${BATCH} sleep=${SLEEP}ms limit=${LIMIT || "∞"} only=${ONLY || "ABC"}`
);

/* ------------------------------------------------------------------ *
 * A. 语言旁路表补齐（按 influencer_id 从 bio 推断）
 * ------------------------------------------------------------------ */
async function fillLanguageTable() {
  const target = await queryTikTok(
    `
    SELECT COUNT(*) AS rows_need_language,
           SUM(i.bio IS NOT NULL AND i.bio <> '') AS master_bio_ready,
           COUNT(DISTINCT c.influencer_id) AS distinct_ids
    FROM tiktok_campaign_influencer_candidates c
    LEFT JOIN TikTok_influencer i ON i.influencer_id = c.influencer_id
    LEFT JOIN tiktok_influencer_language l ON l.influencer_id = c.influencer_id COLLATE utf8mb4_0900_ai_ci
    WHERE ${PLATFORM_SQL}
      AND c.influencer_id IS NOT NULL AND c.influencer_id <> ''
      AND l.bio_language IS NULL
    `,
    platformParams()
  );
  const t = target?.[0] || {};
  log(
    `A: 需要补语言的候选行 ${fmt(t.rows_need_language)}（去重红人 ${fmt(t.distinct_ids)}，主档有 bio ${fmt(t.master_bio_ready)}）`
  );
  if (!APPLY) return { scanned: Number(t.rows_need_language || 0), written: 0, detected: 0, no_bio: 0 };

  let lastId = 0;
  let scanned = 0;
  let detected = 0;
  let noBio = 0;
  let written = 0;
  const pending = new Map(); // influencer_id -> {language, confidence, source}

  const flush = async () => {
    if (!pending.size) return;
    const ids = [...pending.keys()];
    const values = [];
    const placeholders = [];
    for (const id of ids) {
      const v = pending.get(id);
      placeholders.push("(?,?,?,?,NOW(),NOW())");
      values.push(id, v.language, v.confidence, v.source);
    }
    const res = await queryTikTok(
      `INSERT INTO tiktok_influencer_language
         (influencer_id, bio_language, bio_language_confidence, bio_language_source,
          bio_language_checked_at, updated_at)
       VALUES ${placeholders.join(",")}
       ON DUPLICATE KEY UPDATE
         bio_language = IF(bio_language IS NULL OR bio_language = '', VALUES(bio_language), bio_language),
         bio_language_confidence = IF(bio_language_confidence IS NULL, VALUES(bio_language_confidence), bio_language_confidence),
         bio_language_source = IF(bio_language_source IS NULL OR bio_language_source = '', VALUES(bio_language_source), bio_language_source),
         bio_language_checked_at = NOW(),
         updated_at = NOW()`,
      values
    );
    written += Number(res?.affectedRows || 0);
    pending.clear();
  };

  for (;;) {
    const rows = await queryTikTok(
      `
      SELECT c.id, c.influencer_id,
             COALESCE(NULLIF(i.bio, ''), JSON_UNQUOTE(JSON_EXTRACT(c.influencer_snapshot, '$.bio'))) AS bio
      FROM tiktok_campaign_influencer_candidates c
      LEFT JOIN TikTok_influencer i ON i.influencer_id = c.influencer_id
      LEFT JOIN tiktok_influencer_language l ON l.influencer_id = c.influencer_id COLLATE utf8mb4_0900_ai_ci
      WHERE c.id > ? AND ${PLATFORM_SQL}
        AND c.influencer_id IS NOT NULL AND c.influencer_id <> ''
        AND l.bio_language IS NULL
      ORDER BY c.id
      LIMIT ?
      `,
      [lastId].concat(PLATFORM === "all" ? [] : [PLATFORM]).concat([BATCH])
    );
    if (!rows?.length) break;
    lastId = rows[rows.length - 1].id;
    scanned += rows.length;

    for (const r of rows) {
      const pid = String(r.influencer_id || "").trim();
      if (!pid || pending.has(pid)) continue;
      const hit = detectBioLanguageProfile(r.bio);
      if (!hit.language) {
        noBio += 1;
        continue;
      }
      pending.set(pid, hit);
      detected += 1;
    }
    if (pending.size >= 1000) await flush();

    if (scanned % (BATCH * 5) === 0) {
      log(`A: scanned=${fmt(scanned)} detected=${fmt(detected)} written=${fmt(written)} no_bio=${fmt(noBio)}`);
    }
    if (LIMIT && scanned >= LIMIT) break;
    await sleep(SLEEP);
  }
  await flush();
  log(`A done: scanned=${fmt(scanned)} detected=${fmt(detected)} written=${fmt(written)} no_bio=${fmt(noBio)}`);
  return { scanned, detected, written, no_bio: noBio };
}

/* ------------------------------------------------------------------ *
 * B/C. 候选快照 JSON_SET（按 id 区间批处理）
 * ------------------------------------------------------------------ */
const ACCT_VALUE = `COALESCE(
    NULLIF(JSON_UNQUOTE(JSON_EXTRACT(c.influencer_snapshot, '$.videoPublishCountry')), ''),
    NULLIF(JSON_UNQUOTE(JSON_EXTRACT(c.influencer_snapshot, '$.video_publish_country')), ''),
    NULLIF(i.video_publish_country, ''),
    NULLIF(i.country, '')
  )`;

async function countSnapshotGaps() {
  const rows = await queryTikTok(
    `
    SELECT SUM(JSON_CONTAINS_PATH(c.influencer_snapshot,'one','$.accountCountry') = 0) AS no_acct,
           SUM(JSON_CONTAINS_PATH(c.influencer_snapshot,'one','$.bioLanguage') = 0) AS no_lang
    FROM tiktok_campaign_influencer_candidates c
    WHERE ${PLATFORM_SQL}
    `,
    platformParams()
  );
  return rows?.[0] || {};
}

async function backfillSnapshot() {
  const maxRow = await queryTikTok(
    `SELECT COALESCE(MAX(id),0) AS m FROM tiktok_campaign_influencer_candidates c WHERE ${PLATFORM_SQL}`,
    platformParams()
  );
  const maxId = Number(maxRow?.[0]?.m || 0);
  log(`B/C: id 上限 ${fmt(maxId)}，分批 ${BATCH}`);

  let acctRows = 0;
  let langRows = 0;
  let done = 0;
  for (let from = 0; from <= maxId; from += BATCH) {
    const to = from + BATCH;
    if (want("B")) {
      if (APPLY) {
        const res = await queryTikTok(
          `
          UPDATE tiktok_campaign_influencer_candidates c
          LEFT JOIN TikTok_influencer i ON i.influencer_id = c.influencer_id
          SET c.influencer_snapshot = JSON_SET(c.influencer_snapshot,
                '$.accountCountry', ${ACCT_VALUE},
                '$.account_country', ${ACCT_VALUE})
          WHERE c.id > ? AND c.id <= ? AND ${PLATFORM_SQL}
            AND JSON_CONTAINS_PATH(c.influencer_snapshot,'one','$.accountCountry') = 0
            AND ${ACCT_VALUE} IS NOT NULL
          `,
          [from, to].concat(PLATFORM === "all" ? [] : [PLATFORM])
        );
        acctRows += Number(res?.affectedRows || 0);
      } else {
        const cnt = await queryTikTok(
          `
          SELECT COUNT(*) AS n
          FROM tiktok_campaign_influencer_candidates c
          LEFT JOIN TikTok_influencer i ON i.influencer_id = c.influencer_id
          WHERE c.id > ? AND c.id <= ? AND ${PLATFORM_SQL}
            AND JSON_CONTAINS_PATH(c.influencer_snapshot,'one','$.accountCountry') = 0
            AND ${ACCT_VALUE} IS NOT NULL
          `,
          [from, to].concat(PLATFORM === "all" ? [] : [PLATFORM])
        );
        acctRows += Number(cnt?.[0]?.n || 0);
      }
    }
    if (want("C")) {
      if (APPLY) {
        const res = await queryTikTok(
          `
          UPDATE tiktok_campaign_influencer_candidates c
          JOIN tiktok_influencer_language l ON l.influencer_id = c.influencer_id COLLATE utf8mb4_0900_ai_ci
          SET c.influencer_snapshot = JSON_SET(c.influencer_snapshot,
                '$.bioLanguage', l.bio_language,
                '$.bioLanguageConfidence', l.bio_language_confidence,
                '$.bioLanguageSource', l.bio_language_source)
          WHERE c.id > ? AND c.id <= ? AND ${PLATFORM_SQL}
            AND JSON_CONTAINS_PATH(c.influencer_snapshot,'one','$.bioLanguage') = 0
            AND l.bio_language IS NOT NULL AND l.bio_language <> ''
          `,
          [from, to].concat(PLATFORM === "all" ? [] : [PLATFORM])
        );
        langRows += Number(res?.affectedRows || 0);
      } else {
        const cnt = await queryTikTok(
          `
          SELECT COUNT(*) AS n
          FROM tiktok_campaign_influencer_candidates c
          JOIN tiktok_influencer_language l ON l.influencer_id = c.influencer_id COLLATE utf8mb4_0900_ai_ci
          WHERE c.id > ? AND c.id <= ? AND ${PLATFORM_SQL}
            AND JSON_CONTAINS_PATH(c.influencer_snapshot,'one','$.bioLanguage') = 0
            AND l.bio_language IS NOT NULL AND l.bio_language <> ''
          `,
          [from, to].concat(PLATFORM === "all" ? [] : [PLATFORM])
        );
        langRows += Number(cnt?.[0]?.n || 0);
      }
    }
    done += 1;
    if (done % 10 === 0) {
      log(`B/C: id<=${fmt(to)} acct=${fmt(acctRows)} lang=${fmt(langRows)}`);
    }
    if (LIMIT && acctRows + langRows >= LIMIT) break;
    await sleep(SLEEP);
  }
  log(`B/C done: acct=${fmt(acctRows)} lang=${fmt(langRows)} (${APPLY ? "已写入" : "待写入"})`);
  return { acctRows, langRows };
}

const gapsBefore = await countSnapshotGaps();
log(
  `存量：缺 accountCountry ${fmt(gapsBefore.no_acct)} 行，缺 bioLanguage ${fmt(gapsBefore.no_lang)} 行`
);

const a = want("A") ? await fillLanguageTable() : null;
const bc = await backfillSnapshot();

const gapsAfter = await countSnapshotGaps();
log(`收尾：缺 accountCountry ${fmt(gapsAfter.no_acct)} 行，缺 bioLanguage ${fmt(gapsAfter.no_lang)} 行`);
log(`SUMMARY ${JSON.stringify({ apply: APPLY, platform: PLATFORM, language: a, snapshot: bc })}`);
process.exit(0);
