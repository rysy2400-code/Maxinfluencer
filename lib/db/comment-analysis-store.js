/**
 * 评论数据分析落库：
 *   1) 主档 tiktok_influencer（权威存储，按 platform+username 唯一键）
 *   2) 快照：tiktok_campaign_influencer_candidates.influencer_snapshot
 *            tiktok_campaign_execution.influencer_snapshot
 *
 * 两个购买意愿口径都落库：
 *   - official：TikTok 官方 is_high_purchase_intent（IG 无）
 *   - llm     ：按「问价/求链接/问渠道」口径的 LLM 判定
 *   展示值 = official 优先，缺失回落 llm，来源记录在 *_source。
 */
import { queryTikTok } from "./mysql-tiktok.js";

function parseJson(value) {
  if (value == null) return null;
  if (typeof value === "object") return value;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function toNum(v) {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * 写入主档。只做 UPDATE —— 主档行由既有流程创建；若缺失则记 warning 并跳过。
 * @returns {Promise<{updated:number, missing:string[]}>}
 */
export async function upsertCommentAnalysisToMaster(records) {
  const list = (records || []).filter((r) => r?.platform && r?.username);
  let updated = 0;
  const missing = [];
  for (const r of list) {
    const res = await queryTikTok(
      `UPDATE tiktok_influencer SET
         comment_analysis_quality_ratio = ?,
         comment_analysis_purchase_intent = ?,
         comment_analysis_purchase_intent_official = ?,
         comment_analysis_purchase_intent_llm = ?,
         comment_analysis_purchase_intent_source = ?,
         comment_analysis_language_mix = ?,
         comment_analysis_language_source = ?,
         comment_analysis_content_directions = ?,
         comment_analysis_fan_loyalty = ?,
         comment_analysis_summary = ?,
         comment_analysis_videos = ?,
         comment_analysis_comments = ?,
         comment_analysis_model = ?,
         comment_analysis_at = CURRENT_TIMESTAMP
       WHERE platform = ? AND username = ?`,
      [
        r.qualityCommentRatio ?? null,
        r.purchaseIntentRatio ?? null,
        r.purchaseIntentRatioOfficial ?? null,
        r.purchaseIntentRatioLlm ?? null,
        r.purchaseIntentSource ?? null,
        r.languageMix ? JSON.stringify(r.languageMix) : null,
        r.languageSource ?? null,
        r.contentDirections ? JSON.stringify(r.contentDirections) : null,
        r.fanLoyalty ? JSON.stringify(r.fanLoyalty) : null,
        r.analysisSummary ?? null,
        r.videosAnalyzed ?? null,
        r.commentsSampled ?? null,
        r.llmModel ?? null,
        r.platform,
        r.username,
      ]
    );
    if (Number(res?.affectedRows || 0) > 0) updated += 1;
    else missing.push(`${r.platform}:${r.username}`);
  }
  return { updated, missing };
}

function buildSnapshotJsonObject() {
  return `JSON_OBJECT(
    'qualityCommentRatio', ?,
    'purchaseIntentRatio', ?,
    'purchaseIntentRatioOfficial', ?,
    'purchaseIntentRatioLlm', ?,
    'purchaseIntentSource', ?,
    'languageMix', CAST(? AS JSON),
    'languageSource', ?,
    'contentDirections', CAST(? AS JSON),
    'fanLoyalty', CAST(? AS JSON),
    'summary', ?,
    'videosAnalyzed', ?,
    'commentsSampled', ?,
    'model', ?,
    'generatedAt', ?
  )`;
}

function snapshotParams(r) {
  return [
    r.qualityCommentRatio ?? null,
    r.purchaseIntentRatio ?? null,
    r.purchaseIntentRatioOfficial ?? null,
    r.purchaseIntentRatioLlm ?? null,
    r.purchaseIntentSource ?? null,
    r.languageMix ? JSON.stringify(r.languageMix) : null,
    r.languageSource ?? null,
    r.contentDirections ? JSON.stringify(r.contentDirections) : null,
    r.fanLoyalty ? JSON.stringify(r.fanLoyalty) : null,
    r.analysisSummary ?? null,
    r.videosAnalyzed ?? null,
    r.commentsSampled ?? null,
    r.llmModel ?? null,
    new Date().toISOString(),
  ];
}

/**
 * 同步到候选表与执行表快照（$.commentAnalysis）。
 * @param {Array<object>} records 需含 campaignId / platform / username
 */
export async function syncCommentAnalysisToSnapshots(records) {
  const list = (records || []).filter((r) => r?.campaignId && r?.username && r?.status === "ok");
  let candidate = 0;
  let execution = 0;
  for (const r of list) {
    const objSql = buildSnapshotJsonObject();
    const params = snapshotParams(r);
    const c = await queryTikTok(
      `UPDATE tiktok_campaign_influencer_candidates
       SET influencer_snapshot = JSON_SET(COALESCE(influencer_snapshot, JSON_OBJECT()), '$.commentAnalysis', ${objSql})
       WHERE campaign_id = ? AND tiktok_username = ?`,
      [...params, r.campaignId, r.username]
    );
    candidate += Number(c?.affectedRows || 0);
    const e = await queryTikTok(
      `UPDATE tiktok_campaign_execution
       SET influencer_snapshot = JSON_SET(COALESCE(influencer_snapshot, JSON_OBJECT()), '$.commentAnalysis', ${objSql})
       WHERE campaign_id = ? AND tiktok_username = ?`,
      [...params, r.campaignId, r.username]
    );
    execution += Number(e?.affectedRows || 0);
  }
  return { candidate, execution };
}

function mapMasterRow(row) {
  if (!row) return null;
  return {
    platform: row.platform,
    username: row.username,
    qualityCommentRatio: toNum(row.comment_analysis_quality_ratio),
    purchaseIntentRatio: toNum(row.comment_analysis_purchase_intent),
    purchaseIntentRatioOfficial: toNum(row.comment_analysis_purchase_intent_official),
    purchaseIntentRatioLlm: toNum(row.comment_analysis_purchase_intent_llm),
    purchaseIntentSource: row.comment_analysis_purchase_intent_source || null,
    languageMix: parseJson(row.comment_analysis_language_mix) || {},
    languageSource: row.comment_analysis_language_source || null,
    contentDirections: parseJson(row.comment_analysis_content_directions) || [],
    fanLoyalty: parseJson(row.comment_analysis_fan_loyalty) || null,
    analysisSummary: row.comment_analysis_summary || null,
    videosAnalyzed: toNum(row.comment_analysis_videos),
    commentsSampled: toNum(row.comment_analysis_comments),
    llmModel: row.comment_analysis_model || null,
    generatedAt: row.comment_analysis_at ? new Date(row.comment_analysis_at).toISOString() : null,
  };
}

/** 批量读取（主档） */
export async function getCommentAnalyses(platform, usernames) {
  const list = [...new Set((usernames || []).filter(Boolean))];
  if (!list.length) return {};
  const rows = await queryTikTok(
    `SELECT * FROM tiktok_influencer
     WHERE platform = ? AND username IN (${list.map(() => "?").join(",")})`,
    [platform, ...list]
  );
  const out = {};
  for (const row of rows) {
    const mapped = mapMasterRow(row);
    if (mapped?.generatedAt) out[row.username] = mapped;
  }
  return out;
}

/** 已有分析结果的主档 key 集合（用于跳过重复计算） */
export async function listAnalyzedKeys() {
  const rows = await queryTikTok(
    `SELECT platform, username FROM tiktok_influencer
     WHERE comment_analysis_at IS NOT NULL`,
    []
  );
  return new Set(rows.map((r) => `${r.platform}:${r.username}`));
}
