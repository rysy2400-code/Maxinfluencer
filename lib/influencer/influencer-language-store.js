/**
 * 红人语言读写。
 *
 * 2026-09 起语言改为**主档列**（TikTok_influencer.bio_language / bio_language_source /
 * bio_language_confidence / bio_language_checked_at，INSTANT 加列、不重建 35 GB 表）：
 * 语言是红人属性，爬虫 enrich 时本来就在写这一行，放主档可以省掉一次额外写，
 * 且发信/agent 侧按 influencer_id 直接取，不再依赖旁路表 join。
 *
 * 过渡期仍双写旁路小表 tiktok_influencer_language（历史上先有这个表，且
 * 2026-09-24：主档列回填完成、全舰队双写验证通过（旁路表 side_only=0）后，
 * 已**停写并停读**旁路表 —— 语言只走主档列，旁路表可以 drop。
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
  sideTableWrite = false,
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

  // 2026-09-24 停写旁路表：主档列已是权威来源，旁路表进入只读观察期。
  if (sideTableWrite) {
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
  }
  return { written: true, language, sideTableWritten: sideTableWrite };
}

/**
 * 读取单个红人的语言记录（发信前决定语言用）。
 * @param {string} influencerId
 */
export async function getInfluencerLanguage(influencerId) {
  const pid = normalizeInfluencerKey(influencerId);
  if (!pid) return null;
  const rows = await queryTikTok(
    `SELECT bio_language, bio_language_confidence, bio_language_source
     FROM ${INFLUENCER_TABLE}
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
    // 沟通语言已下线（回复语言由 agent prompt 按会话历史判断），保留字段只为兼容调用方。
    communicationLanguage: null,
    communicationLanguageSource: null,
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
      `SELECT influencer_id AS pid, bio_language, bio_language_confidence
       FROM ${INFLUENCER_TABLE}
       WHERE influencer_id IN (${chunk.map(() => "?").join(",")})`,
      chunk
    );
    for (const r of rows || []) {
      map.set(String(r.pid), {
        bioLanguage: r.bio_language || null,
        bioLanguageConfidence:
          r.bio_language_confidence == null ? null : Number(r.bio_language_confidence),
        communicationLanguage: null,
      });
    }
  }
  return map;
}
