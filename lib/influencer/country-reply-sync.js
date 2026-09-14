import { queryTikTok } from "../db/mysql-tiktok.js";
import { normalizeInfluencerCountryToIso } from "./campaign-country-codes.js";
import { ISO_TO_ZH_LABEL, LABEL_TO_ISO } from "./iso-country-registry.js";

function parseJson(value) {
  if (value == null) return null;
  if (typeof value === "object") return value;
  if (typeof value !== "string") return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

export function resolveSnapshotCountry(snapshot = {}) {
  if (!snapshot || typeof snapshot !== "object") return null;
  const candidates = [
    snapshot.videoPublishCountry,
    snapshot.video_publish_country,
    snapshot.country,
    snapshot.countryCode,
    snapshot.accountCountry,
    snapshot.accountCountryRaw,
    snapshot.profile_data?.videoPublishCountry,
    snapshot.profileData?.videoPublishCountry,
    snapshot.profile_data?.userInfo?.country,
    snapshot.profileData?.userInfo?.country,
  ];
  for (const raw of candidates) {
    const iso = normalizeInfluencerCountryToIso(raw);
    if (iso) return iso;
  }
  return null;
}

export function shouldAskCountryInOutreach({ influencer, executionSnapshot } = {}) {
  return !(
    normalizeInfluencerCountryToIso(influencer?.country) ||
    normalizeInfluencerCountryToIso(influencer?.region) ||
    resolveSnapshotCountry(executionSnapshot)
  );
}

function buildCountryNameRegexParts() {
  const names = [];
  for (const [iso, zh] of Object.entries(ISO_TO_ZH_LABEL)) {
    names.push([iso, iso]);
    if (zh) names.push([zh, iso]);
  }
  for (const [label, iso] of Object.entries(LABEL_TO_ISO)) {
    if (/^[a-z]{2}$/.test(label)) continue;
    names.push([label, iso]);
  }
  names.push(
    ["usa", "US"],
    ["u.s.a", "US"],
    ["u.s.", "US"],
    ["united states", "US"],
    ["america", "US"],
    ["uk", "GB"],
    ["u.k.", "GB"],
    ["united kingdom", "GB"],
    ["england", "GB"],
    ["scotland", "GB"],
    ["wales", "GB"],
    ["northern ireland", "GB"],
    ["uae", "AE"],
    ["u.a.e.", "AE"],
    ["dubai", "AE"],
    ["taiwan", "TW"],
    ["hong kong", "HK"],
    ["south korea", "KR"],
    ["korea", "KR"],
    ["russia", "RU"],
    ["vietnam", "VN"]
  );
  return names
    .map(([label, iso]) => [String(label || "").trim(), iso])
    .filter(([label]) => label)
    .sort((a, b) => b[0].length - a[0].length);
}

const COUNTRY_NAME_PARTS = buildCountryNameRegexParts();

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isBareIsoCandidate(text, index, label) {
  if (!/^[A-Z]{2}$/.test(label)) return true;
  const before = text.slice(Math.max(0, index - 28), index).toLowerCase();
  return /\b(based|located|live|living|from|in|country|ship|shipping|reside|resident|currently)\b/.test(before);
}

/**
 * 旧的纯正则国家识别（保留作参考/单测与离线分析）。
 * ⚠️ 已不作为写库依据：它会把 "my ID: 123"（印尼 ISO）或 "your clients come from
 * the Greater China region?"（问对方 agency）当成红人所在地。
 * 现网写库走 applyResidenceCountryFromDelta（LLM profileDelta + 护栏）。
 */
export function extractCountryFromReplyText(bodyText) {
  const text = String(bodyText || "").trim();
  if (!text) return null;

  for (const [label, iso] of COUNTRY_NAME_PARTS) {
    const asciiWord = /^[a-z0-9 .-]+$/i.test(label);
    const bareIso = /^[A-Z]{2}$/.test(label);
    const pattern = asciiWord
      ? new RegExp(
          `(^|[^A-Za-z0-9])${escapeRegex(label)}([^A-Za-z0-9]|$)`,
          bareIso ? "" : "i"
        )
      : new RegExp(escapeRegex(label), "i");
    const match = text.match(pattern);
    if (!match) continue;
    const index = match.index == null ? 0 : match.index + (match[1] ? match[1].length : 0);
    if (!isBareIsoCandidate(text, index, label)) continue;
    const normalized = normalizeInfluencerCountryToIso(iso);
    if (normalized) {
      return {
        iso: normalized,
        raw: label,
        confidence: /\b(based|located|live|living|from|country|reside|currently)\b/i.test(text)
          ? 0.9
          : 0.75,
        source: "email_reply_rule",
      };
    }
  }

  return null;
}

/** 红人本人在邮件中确认的常住地来源标记（与旧的规则误判来源 email_reply 区分） */
export const RESIDENCE_COUNTRY_SOURCE = "email_reply_llm";

/** 只有红人自述常住地、且有原句证据、置信度过线才允许写库 */
export const MIN_RESIDENCE_CONFIDENCE = 0.7;

/** 只接受红人本人陈述的常住地；旅行/他人/引用历史/未知一律不写 */
export const SELF_RESIDENCE_RELATION = "self_residence";

/**
 * 纯函数护栏：把 LLM 返回的 profileDelta 判定为「可写入的国家更新」或拒绝原因。
 * 不碰数据库，便于单测。
 *
 * @param {object|null|undefined} profileDelta
 * @returns {{ok:true, iso:string, raw:string, evidence:string, confidence:number, relation:string}
 *          | {ok:false, reason:string, [key:string]:unknown}}
 */
export function resolveResidenceCountryUpdate(profileDelta) {
  if (!profileDelta || typeof profileDelta !== "object") {
    return { ok: false, reason: "missing_profile_delta" };
  }

  const relation = String(profileDelta.residenceRelation || "").trim();
  if (relation !== SELF_RESIDENCE_RELATION) {
    return { ok: false, reason: "not_self_residence", relation };
  }

  const rawCountry = profileDelta.residenceCountry;
  const iso = normalizeInfluencerCountryToIso(rawCountry);
  if (!iso) {
    return { ok: false, reason: "country_not_normalized", rawCountry };
  }

  const evidence = String(profileDelta.residenceEvidenceQuote || "").trim();
  if (evidence.length < 4) {
    return { ok: false, reason: "missing_evidence", iso };
  }

  const confidence = Number(profileDelta.residenceConfidence);
  if (!Number.isFinite(confidence) || confidence < MIN_RESIDENCE_CONFIDENCE) {
    return { ok: false, reason: "low_confidence", iso, confidence };
  }

  return {
    ok: true,
    iso,
    raw: rawCountry != null ? String(rawCountry) : iso,
    evidence,
    confidence,
    relation,
  };
}

function withResidenceCountry(snapshot, countryInfo, event) {
  const base = snapshot && typeof snapshot === "object" ? { ...snapshot } : {};
  const now = new Date().toISOString();
  return {
    ...base,
    videoPublishCountry: countryInfo.iso,
    video_publish_country: countryInfo.iso,
    countrySource: RESIDENCE_COUNTRY_SOURCE,
    videoPublishCountrySource: RESIDENCE_COUNTRY_SOURCE,
    countryUpdatedAt: now,
    countryConfidence: countryInfo.confidence,
    countryRaw: countryInfo.raw,
    countryRelation: countryInfo.relation,
    countryEvidence: countryInfo.evidence,
    countryReplySourceMessageId: event?.message_id || null,
  };
}

async function writeResidenceCountryToDb({
  influencerId,
  countryInfo,
  event,
  executions,
}) {
  await queryTikTok(
    `UPDATE tiktok_influencer
     SET region = COALESCE(region, ?), updated_at = CURRENT_TIMESTAMP
     WHERE influencer_id = ?`,
    [countryInfo.iso, influencerId]
  );

  try {
    const handles = [
      ...new Set(
        (executions || [])
          .map((exec) => exec?.tiktokUsername || exec?.influencerId)
          .map((v) => String(v || "").replace(/^@/, "").trim().toLowerCase())
          .filter((v) => v && !/^\d{10,}$/.test(v))
      ),
    ];

    const handleClause = handles.length
      ? ` OR username IN (${handles.map(() => "?").join(",")})`
      : "";
    await queryTikTok(
      `UPDATE TikTok_influencer
       SET video_publish_country = ?,
           video_publish_country_source = ?,
           video_publish_country_checked_at = NOW(),
           updated_at = NOW()
       WHERE influencer_id = ? OR username IN (
         SELECT tiktok_username
         FROM tiktok_campaign_execution
         WHERE influencer_id = ?
       )${handleClause}`,
      [
        countryInfo.iso,
        RESIDENCE_COUNTRY_SOURCE,
        influencerId,
        influencerId,
        ...handles,
      ]
    );
  } catch (err) {
    console.warn(
      "[CountryReplySync] 更新 TikTok_influencer.video_publish_country 失败:",
      err?.message || err
    );
  }

  const execFilters = [`influencer_id = ?`];
  const execParams = [influencerId];
  for (const exec of executions || []) {
    const campaignId = exec?.campaignId ? String(exec.campaignId).trim() : "";
    const handle = exec?.tiktokUsername
      ? String(exec.tiktokUsername).replace(/^@/, "").trim()
      : "";
    if (!campaignId || !handle) continue;
    execFilters.push(`(campaign_id = ? AND tiktok_username = ?)`);
    execParams.push(campaignId, handle);
  }

  const rows = await queryTikTok(
    `SELECT id, influencer_snapshot
     FROM tiktok_campaign_execution
     WHERE ${execFilters.join(" OR ")}`,
    execParams
  );

  let executionUpdated = 0;
  for (const row of rows || []) {
    const snapshot = parseJson(row.influencer_snapshot) || {};
    const nextSnapshot = withResidenceCountry(snapshot, countryInfo, event);
    await queryTikTok(
      `UPDATE tiktok_campaign_execution
       SET influencer_snapshot = ?, updated_at = NOW()
       WHERE id = ?`,
      [JSON.stringify(nextSnapshot), row.id]
    );
    executionUpdated += 1;
  }

  return executionUpdated;
}

/**
 * 用事件决策 LLM 返回的 profileDelta 写红人常住地。
 * 必须通过 resolveResidenceCountryUpdate 的护栏才会落库。
 */
export async function applyResidenceCountryFromDelta({
  influencerId,
  profileDelta,
  event,
  executions = [],
} = {}) {
  const pid = influencerId != null ? String(influencerId).trim() : "";
  if (!pid) return { changed: false, reason: "missing_influencer_id" };

  const resolved = resolveResidenceCountryUpdate(profileDelta);
  if (!resolved.ok) return { changed: false, ...resolved };

  const executionsUpdated = await writeResidenceCountryToDb({
    influencerId: pid,
    countryInfo: resolved,
    event,
    executions,
  });

  return {
    changed: true,
    countryIso: resolved.iso,
    countryRaw: resolved.raw,
    confidence: resolved.confidence,
    relation: resolved.relation,
    evidence: resolved.evidence,
    executionsUpdated,
  };
}
