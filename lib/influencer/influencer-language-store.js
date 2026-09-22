/**
 * 红人语言读写。
 *
 * 2026-09 起语言改为**主档列**（TikTok_influencer.bio_language / bio_language_source /
 * bio_language_confidence / bio_language_checked_at，INSTANT 加列、不重建 35 GB 表）：
 * 语言是红人属性，爬虫 enrich 时本来就在写这一行，放主档可以省掉一次额外写，
 * 且发信/agent 侧按 influencer_id 直接取，不再依赖旁路表 join。
 *
 * 过渡期仍双写旁路小表 tiktok_influencer_language（历史上先有这个表，且
 * communication_language「发信语言」暂存在那里）；读优先主档、旁路表兜底。
 * 表结构见 scripts/add-influencer-language-table.js。
 */
import { queryTikTok } from "../db/mysql-tiktok.js";
import { normalizeLanguageCode } from "./infer-bio-language.js";

export const INFLUENCER_LANGUAGE_TABLE = "tiktok_influencer_language";
export const INFLUENCER_TABLE = "TikTok_influencer";

/**
 * 写主档语言列（权威来源）。失败只告警，不影响调用方主流程。
 * @returns {Promise<number>} 影响行数
 */
async function writeLanguageToMaster({ influencerId, language, confidence, source }) {
  const res = await queryTikTok(
    `UPDATE ${INFLUENCER_TABLE}
        SET bio_language = ?,
            bio_language_source = ?,
            bio_language_confidence = ?,
            bio_language_checked_at = NOW()
      WHERE influencer_id = ?
      LIMIT 1`,
    [
      language,
      source ? String(source).slice(0, 32) : null,
      confidence == null ? null : confidence,
      influencerId,
    ]
  );
  return Number(res?.affectedRows || 0);
}

function normalizeInfluencerKey(influencerId) {
  const id = influencerId == null ? "" : String(influencerId).trim();
  return id || null;
}

/**
 * 写入 red人主页简介推断出的语言（不动沟通语言）。
 * @param {{influencerId:string, bioLanguage?:string|null, confidence?:number|null, source?:string|null}} input
 * @returns {Promise<{written:boolean, language?:string|null, reason?:string}>}
 */
export async function upsertBioLanguage({
  influencerId,
  bioLanguage = null,
  confidence = null,
  source = null,
  syncMaster = true,
} = {}) {
  const pid = normalizeInfluencerKey(influencerId);
  if (!pid) return { written: false, reason: "missing_influencer_id" };

  const language = normalizeLanguageCode(bioLanguage);
  const conf =
    confidence != null && Number.isFinite(Number(confidence))
      ? Number(confidence)
      : null;

  // 推断不出来时不覆盖历史值，只跳过（避免把已有结果抹掉）。
  if (!language) return { written: false, reason: "no_language" };

  // 主档列优先写（权威）；旁路表是过渡期双写。
  if (syncMaster) {
    try {
      await writeLanguageToMaster({
        influencerId: pid,
        language,
        confidence: conf,
        source,
      });
    } catch (err) {
      console.warn(
        `[influencer-language] 主档语言写入失败 influencer_id=${pid}: ${err?.message || err}`
      );
    }
  }

  await queryTikTok(
    `INSERT INTO ${INFLUENCER_LANGUAGE_TABLE}
       (influencer_id, bio_language, bio_language_confidence, bio_language_source,
        bio_language_checked_at, updated_at)
     VALUES (?, ?, ?, ?, NOW(), NOW())
     ON DUPLICATE KEY UPDATE
       bio_language = VALUES(bio_language),
       bio_language_confidence = VALUES(bio_language_confidence),
       bio_language_source = VALUES(bio_language_source),
       bio_language_checked_at = NOW(),
       updated_at = NOW()`,
    [pid, language, conf, source ? String(source).slice(0, 32) : null]
  );
  return { written: true, language };
}

/**
 * 写入「与该红人发信使用的语言」。现网以红人最近一次回复语言为准。
 * @param {{influencerId:string, language?:string|null, source?:string|null}} input
 */
export async function upsertCommunicationLanguage({
  influencerId,
  language = null,
  source = null,
} = {}) {
  const pid = normalizeInfluencerKey(influencerId);
  if (!pid) return { written: false, reason: "missing_influencer_id" };

  const normalized = normalizeLanguageCode(language);
  if (!normalized) return { written: false, reason: "unsupported_language" };

  await queryTikTok(
    `INSERT INTO ${INFLUENCER_LANGUAGE_TABLE}
       (influencer_id, communication_language, communication_language_source,
        communication_language_updated_at, updated_at)
     VALUES (?, ?, ?, NOW(), NOW())
     ON DUPLICATE KEY UPDATE
       communication_language = VALUES(communication_language),
       communication_language_source = VALUES(communication_language_source),
       communication_language_updated_at = NOW(),
       updated_at = NOW()`,
    [
      pid,
      normalized,
      source ? String(source).slice(0, 32) : "reply",
    ]
  );
  return { written: true, language: normalized };
}

/**
 * 读取单个红人的语言记录（发信前决定语言用）。
 * @param {string} influencerId
 */
export async function getInfluencerLanguage(influencerId) {
  const pid = normalizeInfluencerKey(influencerId);
  if (!pid) return null;
  const rows = await queryTikTok(
    `SELECT i.bio_language AS master_language,
            i.bio_language_confidence AS master_confidence,
            i.bio_language_source AS master_source,
            l.bio_language AS side_language,
            l.bio_language_confidence AS side_confidence,
            l.bio_language_source AS side_source,
            l.communication_language,
            l.communication_language_source
     FROM ${INFLUENCER_TABLE} i
     LEFT JOIN ${INFLUENCER_LANGUAGE_TABLE} l
            ON l.influencer_id = i.influencer_id COLLATE utf8mb4_0900_ai_ci
     WHERE i.influencer_id = ?
     LIMIT 1`,
    [pid]
  );
  const r = rows?.[0];
  if (!r) return null;
  return {
    // 读优先主档列，旁路表兜底（过渡期两者一致）
    bioLanguage: r.master_language || r.side_language || null,
    bioLanguageConfidence:
      r.master_language != null
        ? r.master_confidence == null
          ? null
          : Number(r.master_confidence)
        : r.side_confidence == null
          ? null
          : Number(r.side_confidence),
    bioLanguageSource: (r.master_language ? r.master_source : r.side_source) || null,
    communicationLanguage: r.communication_language || null,
    communicationLanguageSource: r.communication_language_source || null,
  };
}

/**
 * 批量读取（执行卡片按 influencer_id 列表回填语言用）。
 * @param {string[]} influencerIds
 * @returns {Promise<Map<string, {bioLanguage:string|null, bioLanguageConfidence:number|null, communicationLanguage:string|null}>>}
 */
export async function loadInfluencerLanguageMap(influencerIds = []) {
  const ids = [
    ...new Set(
      (influencerIds || [])
        .map((v) => normalizeInfluencerKey(v))
        .filter(Boolean)
    ),
  ];
  const map = new Map();
  if (!ids.length) return map;

  // 分片查询，避免 IN 列表过长
  const CHUNK = 500;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK);
    const rows = await queryTikTok(
      `SELECT i.influencer_id AS pid,
              i.bio_language AS master_language,
              i.bio_language_confidence AS master_confidence,
              l.bio_language AS side_language,
              l.bio_language_confidence AS side_confidence,
              l.communication_language
       FROM ${INFLUENCER_TABLE} i
       LEFT JOIN ${INFLUENCER_LANGUAGE_TABLE} l
              ON l.influencer_id = i.influencer_id COLLATE utf8mb4_0900_ai_ci
       WHERE i.influencer_id IN (${chunk.map(() => "?").join(",")})`,
      chunk
    );
    for (const r of rows || []) {
      const bioLanguage = r.master_language || r.side_language || null;
      const confidence = r.master_language
        ? r.master_confidence
        : r.side_confidence;
      map.set(String(r.pid), {
        bioLanguage,
        bioLanguageConfidence:
          confidence == null ? null : Number(confidence),
        communicationLanguage: r.communication_language || null,
      });
    }
  }
  return map;
}
