/**
 * 红人语言读写（旁路小表 tiktok_influencer_language）。
 *
 * 为什么不写在 TikTok_influencer 上：该表千万级 / 数十 GB，且线上存在长事务持有元数据锁，
 * 加列会堵塞爬虫写入，逐行 UPDATE 也会放大 binlog。语言是派生属性，放独立小表更安全。
 *
 * 表结构见 scripts/add-influencer-language-table.js。
 */
import { queryTikTok } from "../db/mysql-tiktok.js";
import { normalizeLanguageCode } from "./infer-bio-language.js";

export const INFLUENCER_LANGUAGE_TABLE = "tiktok_influencer_language";

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
    `SELECT bio_language, bio_language_confidence, bio_language_source,
            communication_language, communication_language_source
     FROM ${INFLUENCER_LANGUAGE_TABLE}
     WHERE influencer_id = ?
     LIMIT 1`,
    [pid]
  );
  const r = rows?.[0];
  if (!r) return null;
  return {
    bioLanguage: r.bio_language || null,
    bioLanguageConfidence:
      r.bio_language_confidence == null ? null : Number(r.bio_language_confidence),
    bioLanguageSource: r.bio_language_source || null,
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
      `SELECT influencer_id, bio_language, bio_language_confidence, communication_language
       FROM ${INFLUENCER_LANGUAGE_TABLE}
       WHERE influencer_id IN (${chunk.map(() => "?").join(",")})`,
      chunk
    );
    for (const r of rows || []) {
      map.set(String(r.influencer_id), {
        bioLanguage: r.bio_language || null,
        bioLanguageConfidence:
          r.bio_language_confidence == null
            ? null
            : Number(r.bio_language_confidence),
        communicationLanguage: r.communication_language || null,
      });
    }
  }
  return map;
}
