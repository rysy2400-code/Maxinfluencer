import { queryTikTok } from "./mysql-tiktok.js";

/**
 * 平台标识归一化：落库统一小写 slug（tiktok / instagram / youtube / x）。
 * 主档唯一键是 (platform, username)，platform 写法不统一会让同一账号裂成多行，
 * 因此所有写入口都必须先过这里。
 */
export function normalizePlatformSlug(value) {
  const raw = String(value ?? "").trim().toLowerCase();
  if (!raw) return "tiktok";
  if (raw.includes("instagram") || raw === "ig") return "instagram";
  if (raw.includes("youtube") || raw === "yt") return "youtube";
  if (raw === "x" || raw.includes("twitter")) return "x";
  if (raw.includes("tiktok")) return "tiktok";
  return raw;
}

/** handle 归一化：去掉前缀 @ 与首尾空白；空值返回 null。 */
export function normalizeHandle(value) {
  const h = String(value ?? "").replace(/^@/, "").trim();
  return h === "" ? null : h;
}

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
  const platform = normalizePlatformSlug(data.platform);
  const username = normalizeHandle(data.username);
  const profileUrl =
    data.profileUrl ||
    (username
      ? platform === "instagram"
        ? `https://www.instagram.com/${username}`
        : platform === "youtube"
          ? `https://www.youtube.com/@${username}`
          : platform === "x"
            ? `https://x.com/${username}`
            : `https://www.tiktok.com/@${username}`
      : null);
  if (!profileUrl) {
    throw new Error("missing profileUrl (or username to derive it)");
  }

  // 唯一键：(influencer_id) 与 (platform, username)。
  // 冲突说明是同一条平台账号（同一平台同 handle，或同一平台账号 id），
  // 因此可以安全地把 influencer_id / platform / username 一起写成入参值；
  // 跨平台同 handle 不再冲突，会新插入一行。
  const sql = `
    INSERT INTO tiktok_influencer (
      influencer_id, platform, region, username, display_name, avatar_url,
      profile_url,
      followers_count, avg_views, influencer_email, source, source_ref, source_payload, last_fetched_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE
      influencer_id = VALUES(influencer_id),
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
    platform,
    data.region || null,
    username,
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

function mapInfluencerRow(r) {
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

export async function getInfluencerById(influencerId) {
  if (influencerId == null || String(influencerId).trim() === "") return null;
  const id = String(influencerId).trim();
  const rows = await queryTikTok(
    "SELECT * FROM tiktok_influencer WHERE influencer_id = ?",
    [id]
  );
  if (!rows || rows.length === 0) return null;
  return mapInfluencerRow(rows[0]);
}

/**
 * 按 (platform, username) 查主档。
 *
 * 同一 handle 在不同平台是不同账号（主档唯一键已改为 (platform, username)），
 * 所以任何"按用户名找红人"的调用都必须带上平台，否则会随机命中别的平台的行。
 * 不传 platform 时返回全部匹配行，交由调用方判断。
 */
export async function getInfluencersByHandle({ platform = null, username }) {
  const handle = normalizeHandle(username);
  if (!handle) return [];
  const slug = platform ? normalizePlatformSlug(platform) : null;
  const rows = slug
    ? await queryTikTok(
        "SELECT * FROM tiktok_influencer WHERE username = ? AND platform = ? ORDER BY id ASC",
        [handle, slug]
      )
    : await queryTikTok(
        "SELECT * FROM tiktok_influencer WHERE username = ? ORDER BY id ASC",
        [handle]
      );
  return (rows || []).map(mapInfluencerRow);
}

/** 按 (platform, username) 查单条主档；命中多条时取最早创建的一行。 */
export async function getInfluencerByHandle({ platform, username }) {
  const rows = await getInfluencersByHandle({ platform, username });
  return rows[0] || null;
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
