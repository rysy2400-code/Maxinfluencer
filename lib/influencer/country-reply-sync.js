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

function withEmailReplyCountry(snapshot, countryInfo, event) {
  const base = snapshot && typeof snapshot === "object" ? { ...snapshot } : {};
  const now = new Date().toISOString();
  return {
    ...base,
    videoPublishCountry: countryInfo.iso,
    video_publish_country: countryInfo.iso,
    countrySource: "email_reply",
    videoPublishCountrySource: "email_reply",
    countryUpdatedAt: now,
    countryConfidence: countryInfo.confidence,
    countryRaw: countryInfo.raw,
    countryReplySourceMessageId: event?.message_id || null,
  };
}

export async function syncCountryFromReply({ influencerId, event, executions = [] } = {}) {
  const pid = influencerId != null ? String(influencerId).trim() : "";
  if (!pid || !event || !String(event.body_text || "").trim()) {
    return { changed: false, reason: "missing_input" };
  }

  const countryInfo = extractCountryFromReplyText(event.body_text);
  if (!countryInfo?.iso) return { changed: false, reason: "country_not_found" };
  if (Number(countryInfo.confidence || 0) < 0.7) {
    return { changed: false, reason: "low_confidence", countryInfo };
  }

  await queryTikTok(
    `UPDATE tiktok_influencer
     SET region = COALESCE(region, ?), updated_at = CURRENT_TIMESTAMP
     WHERE influencer_id = ?`,
    [countryInfo.iso, pid]
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
      ? ` OR LOWER(username) IN (${handles.map(() => "?").join(",")})`
      : "";
    await queryTikTok(
      `UPDATE TikTok_influencer
       SET video_publish_country = ?, video_publish_country_checked_at = NOW(), updated_at = NOW()
       WHERE influencer_id = ? OR LOWER(username) IN (
         SELECT LOWER(tiktok_username)
         FROM tiktok_campaign_execution
         WHERE influencer_id = ?
       )${handleClause}`,
      [countryInfo.iso, pid, pid, ...handles]
    );
  } catch (err) {
    console.warn(
      "[CountryReplySync] 更新 TikTok_influencer.video_publish_country 失败:",
      err?.message || err
    );
  }

  const execFilters = [`influencer_id = ?`];
  const execParams = [pid];
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
    const nextSnapshot = withEmailReplyCountry(snapshot, countryInfo, event);
    await queryTikTok(
      `UPDATE tiktok_campaign_execution
       SET influencer_snapshot = ?, updated_at = NOW()
       WHERE id = ?`,
      [JSON.stringify(nextSnapshot), row.id]
    );
    executionUpdated += 1;
  }

  return {
    changed: true,
    countryIso: countryInfo.iso,
    countryRaw: countryInfo.raw,
    confidence: countryInfo.confidence,
    executionsUpdated: executionUpdated,
  };
}
