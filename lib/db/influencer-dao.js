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
 *  contacts?: object,
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
      followers_count, avg_views, contacts, source, source_ref, source_payload, last_fetched_at
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
      contacts = VALUES(contacts),
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
    data.contacts ? JSON.stringify(data.contacts) : null,
    data.source || null,
    data.sourceRef || null,
    data.sourcePayload ? JSON.stringify(data.sourcePayload) : null,
    data.lastFetchedAt ? data.lastFetchedAt : null,
  ]);
}

export async function getInfluencerById(influencerId) {
  const rows = await queryTikTok(
    "SELECT * FROM tiktok_influencer WHERE influencer_id = ?",
    [influencerId]
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
    contacts: parseJson(r.contacts),
    source: r.source,
    sourceRef: r.source_ref,
    sourcePayload: parseJson(r.source_payload),
    lastFetchedAt: r.last_fetched_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

