import { queryTikTok } from "./mysql-tiktok.js";

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

/**
 * JSON 列写入前序列化：兼容对象与字符串两种入参。
 * 字符串若已是合法 JSON 原文则原样存储，避免二次编码成 JSON 字符串。
 */
function serializeJsonColumn(value) {
  if (value == null) return null;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed !== "") {
      try {
        JSON.parse(trimmed);
        return trimmed;
      } catch {
        /* 非 JSON 文本，按 JSON 字符串存储 */
      }
    }
    return JSON.stringify(value);
  }
  if (
    typeof value === "object" ||
    typeof value === "boolean" ||
    typeof value === "number"
  ) {
    return JSON.stringify(value);
  }
  return JSON.stringify(String(value));
}

/**
 * Upsert 全局红人缓存
 * @param {{
 *  influencerId: string,
 *  platform?: string,
 *  region?: string,
 *  username?: string,
 *  displayName?: string,
 *  avatarUrl?: string,
 *  followerCount?: number,
 *  avgViews?: number,
 *  influencerEmail?: string|null,
 *  source?: string,
 *  sourceRef?: string,
 *  sourcePayload?: object,
 *  lastFetchedAt?: Date
 * }} data
 */
export async function upsertInfluencer(data) {
  const influencerId = data.influencerId;
  if (!influencerId) throw new Error("missing influencerId");
  const profileUrl =
    data.profileUrl ||
    (data.username ? `https://www.tiktok.com/@${data.username}` : null);
  if (!profileUrl) {
    throw new Error("missing profileUrl (or username to derive it)");
  }

  const sql = `
    INSERT INTO tiktok_influencer (
      influencer_id, platform, region, username, display_name, avatar_url,
      profile_url,
      followers_count, avg_views, influencer_email, source, source_ref, source_payload, last_fetched_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE
      platform = VALUES(platform),
      region = VALUES(region),
      username = VALUES(username),
      display_name = VALUES(display_name),
      avatar_url = VALUES(avatar_url),
      profile_url = VALUES(profile_url),
      followers_count = VALUES(followers_count),
      avg_views = VALUES(avg_views),
      influencer_email = VALUES(influencer_email),
      source = VALUES(source),
      source_ref = VALUES(source_ref),
      source_payload = VALUES(source_payload),
      last_fetched_at = VALUES(last_fetched_at),
      updated_at = CURRENT_TIMESTAMP
  `;

  await queryTikTok(sql, [
    influencerId,
    data.platform || "tiktok",
    data.region || null,
    data.username || null,
    data.displayName || null,
    data.avatarUrl || null,
    profileUrl,
    typeof data.followerCount === "number" ? data.followerCount : null,
    typeof data.avgViews === "number" ? data.avgViews : null,
    data.influencerEmail != null && String(data.influencerEmail).trim() !== ""
      ? String(data.influencerEmail).trim().toLowerCase()
      : null,
    data.source || null,
    data.sourceRef || null,
    serializeJsonColumn(data.sourcePayload),
    data.lastFetchedAt ? data.lastFetchedAt : null,
  ]);
}

export async function getInfluencerById(influencerId) {
  if (influencerId == null || String(influencerId).trim() === "") return null;
  const id = String(influencerId).trim();
  const rows = await queryTikTok(
    "SELECT * FROM tiktok_influencer WHERE influencer_id = ?",
    [id]
  );
  if (!rows || rows.length === 0) return null;
  const r = rows[0];
  return {
    influencerId: r.influencer_id,
    platform: r.platform,
    region: r.region,
    username: r.username,
    displayName: r.display_name,
    avatarUrl: r.avatar_url,
    profileUrl: r.profile_url,
    followerCount: r.followers_count,
    avgViews: r.avg_views,
    influencerEmail: r.influencer_email || null,
    shippingInfo: parseJson(r.shipping_info),
    businessProfileMarkdown: r.business_profile_markdown || null,
    businessProfileUpdatedAt: r.business_profile_updated_at || null,
    businessProfileSourceMessageId: r.business_profile_source_message_id || null,
    contactStatus: r.contact_status || "contactable",
    doNotContactAt: r.do_not_contact_at || null,
    doNotContactReason: r.do_not_contact_reason || null,
    doNotContactSourceMessageId: r.do_not_contact_source_message_id || null,
    handoverMode: r.handover_mode || null,
    source: r.source,
    sourceRef: r.source_ref,
    sourcePayload: parseJson(r.source_payload),
    lastFetchedAt: r.last_fetched_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export async function updateInfluencerBusinessProfile({
  influencerId,
  markdown,
  sourceMessageId = null,
}) {
  const id = String(influencerId || "").trim();
  const body = String(markdown || "").trim();
  if (!id || !body) return false;
  const result = await queryTikTok(
    `UPDATE tiktok_influencer
     SET business_profile_markdown = ?, business_profile_updated_at = NOW(),
         business_profile_source_message_id = ?
     WHERE influencer_id = ?`,
    [body, sourceMessageId, id]
  );
  return Number(result?.affectedRows || 0) > 0;
}

export async function markInfluencerDoNotContact({
  influencerId,
  reason = null,
  sourceMessageId = null,
}) {
  const id = String(influencerId || "").trim();
  if (!id) return false;
  await queryTikTok(
    `UPDATE tiktok_influencer
     SET contact_status = 'do_not_contact', do_not_contact_at = NOW(),
         do_not_contact_reason = ?, do_not_contact_source_message_id = ?
     WHERE influencer_id = ?`,
    [reason ? String(reason).slice(0, 4000) : null, sourceMessageId, id]
  );
  await queryTikTok(
    `UPDATE tiktok_influencer_agent_event
     SET status = 'skipped', error_message = 'influencer_do_not_contact', updated_at = NOW()
     WHERE influencer_id = ? AND status = 'pending'`,
    [id]
  );
  return true;
}
