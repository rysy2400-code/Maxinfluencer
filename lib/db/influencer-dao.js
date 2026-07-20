import { queryTikTok } from "./mysql-tiktok.js";

function parseJson(value) {
  if (value == null) return null;
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    value = Buffer.from(value).toString("utf8");
  }
  if (typeof value === "object") return value;
  if (typeof value !== "string") return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function stripLoneSurrogates(value) {
  const s = String(value);
  let out = "";
  for (let i = 0; i < s.length; i += 1) {
    const code = s.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = s.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        out += s[i] + s[i + 1];
        i += 1;
      } else {
        out += "\uFFFD";
      }
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      out += "\uFFFD";
    } else {
      out += s[i];
    }
  }
  return out;
}

function sanitizeJsonValueForMysql(value, seen = new WeakSet()) {
  if (value == null) return value;
  if (typeof value === "string") return stripLoneSurrogates(value);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (value instanceof Date) return value.toISOString();
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    return stripLoneSurrogates(Buffer.from(value).toString("utf8"));
  }
  if (typeof value !== "object") return stripLoneSurrogates(String(value));
  if (seen.has(value)) return null;
  seen.add(value);
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeJsonValueForMysql(item, seen));
  }
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    out[stripLoneSurrogates(k)] = sanitizeJsonValueForMysql(v, seen);
  }
  return out;
}

function normalizeJsonDbParam(value) {
  const parsed = parseJson(value);
  return parsed == null ? null : JSON.stringify(sanitizeJsonValueForMysql(parsed));
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
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CAST(? AS CHAR CHARACTER SET utf8mb4), ?)
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
    normalizeJsonDbParam(data.sourcePayload),
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
    handoverMode: r.handover_mode || null,
    source: r.source,
    sourceRef: r.source_ref,
    sourcePayload: parseJson(r.source_payload),
    lastFetchedAt: r.last_fetched_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}
