// TikTok 红人数据访问对象（DAO）
// 用于保存和查询 TikTok 红人数据到 TikTok_influencer 表

import { queryTikTok } from "./mysql-tiktok.js";
import { getInfluencerById, upsertInfluencer } from "./influencer-dao.js";

function normalizeEmailFromProfile(value) {
  if (typeof value !== "string" || !value.includes("@")) return null;
  const t = value.trim();
  return t.length > 2 ? t.toLowerCase() : null;
}

/**
 * 爬虫写入 TikTok_influencer 后，将 profile_data.userInfo.email 同步到 tiktok_influencer.influencer_email。
 * 仅同步 influencer_email（contacts 列已移除）。
 */
async function syncTiktokInfluencerGlobalEmail(influencer) {
  const tiktokUserIdRaw =
    influencer.tiktokUserId ||
    influencer.tiktok_user_id ||
    influencer.userId ||
    influencer.profile_data?.userInfo?.userId ||
    influencer.profile_data?.userInfo?.user_id ||
    null;
  const influencerId = tiktokUserIdRaw
    ? String(tiktokUserIdRaw)
    : influencer.influencerId
    ? String(influencer.influencerId)
    : null;
  if (!influencerId) return;

  const fromProfile = normalizeEmailFromProfile(
    influencer.profile_data?.userInfo?.email
  );

  let existing = null;
  try {
    existing = await getInfluencerById(influencerId);
  } catch (e) {
    console.warn(
      "[TikTokInfluencerDAO] 读取 tiktok_influencer 用于同步 influencer_email 失败:",
      e?.message || e
    );
  }

  const influencerEmail = fromProfile || existing?.influencerEmail || null;
  if (!influencerEmail) return;

  const username =
    (influencer.username || "").replace(/^@/, "") || existing?.username || null;
  const profileUrl = influencer.profileUrl || existing?.profileUrl;
  if (!profileUrl) return;

  try {
    await upsertInfluencer({
      influencerId,
      platform: existing?.platform || "tiktok",
      username,
      displayName:
        influencer.displayName ||
        influencer.username ||
        existing?.displayName ||
        username,
      avatarUrl:
        influencer.avatarUrl != null && influencer.avatarUrl !== ""
          ? influencer.avatarUrl
          : existing?.avatarUrl ?? null,
      profileUrl,
      followerCount:
        typeof influencer.followers?.count === "number"
          ? influencer.followers.count
          : existing?.followerCount ?? null,
      avgViews:
        typeof influencer.views?.avg === "number"
          ? influencer.views.avg
          : existing?.avgViews ?? null,
      influencerEmail,
      source: existing?.source || "web_search",
      sourceRef: username || existing?.sourceRef || null,
      sourcePayload: existing?.sourcePayload ?? null,
      lastFetchedAt: new Date(),
    });
  } catch (e) {
    console.warn(
      "[TikTokInfluencerDAO] 同步 tiktok_influencer.influencer_email 失败:",
      e?.message || e
    );
  }
}

/**
 * 保存或更新 TikTok 红人数据
 * @param {Object} influencer - 红人数据对象
 * @param {string} influencer.username - 用户名（必填）
 * @param {string} influencer.displayName - 显示名称
 * @param {string} influencer.profileUrl - 主页链接（必填）
 * @param {string} influencer.avatarUrl - 头像URL
 * @param {Object} influencer.followers - 粉丝数据 {count: number, display: string}
 * @param {Object} influencer.views - 播放数据 {avg: number, display: string}
 * @param {Object} influencer.engagement - 互动数据 {rate: number, avgLikes: number, avgComments: number}
 * @param {string} influencer.bio - 个人简介
 * @param {boolean} influencer.verified - 是否认证
 * @param {string} influencer.country - 国家
 * @param {string} influencer.accountType - 账户类型
 * @param {Array<string>} influencer.accountTypes - 账户类型数组
 * @param {number} influencer.cpm - CPM
 * @param {number} influencer.following - 关注数
 * @param {number} influencer.postsCount - 视频数
 * @param {Object} influencer.profile_data - 完整的红人数据（JSON格式，包含所有提取的信息：videos数组、statistics、interceptedApis等）
 * @param {Array} influencer.search_video_data - 搜索视频数据（JSON格式，基于关键词搜索获取的视频数据，按红人分组）
 * @param {boolean} options.updateProfileOnly - 是否只更新 profile_data（不更新 search_video_data），默认 false
 * @returns {Promise<Object>} - 保存结果 {success: boolean, id: number, message: string}
 */
export async function saveTikTokInfluencer(influencer, options = {}) {
  try {
    // 验证必填字段
    if (!influencer.username || !influencer.profileUrl) {
      throw new Error('username 和 profileUrl 是必填字段');
    }

    // 准备数据
    const username = influencer.username.replace(/^@/, ''); // 移除 @ 符号
    const displayName = influencer.displayName || influencer.username;
    const profileUrl = influencer.profileUrl;
    const avatarUrl = influencer.avatarUrl || '';
    const bio = influencer.bio || '';
    const verified = influencer.verified || false;
    const country = influencer.country || '';

    // TikTok 稳定 ID（用于项目 influencerId）
    const tiktokUserIdRaw =
      influencer.tiktokUserId ||
      influencer.tiktok_user_id ||
      influencer.userId ||
      influencer.profile_data?.userInfo?.userId ||
      influencer.profile_data?.userInfo?.user_id ||
      null;
    const tiktokSecUidRaw =
      influencer.tiktokSecUid ||
      influencer.tiktok_sec_uid ||
      influencer.secUid ||
      influencer.profile_data?.userInfo?.secUid ||
      influencer.profile_data?.userInfo?.sec_uid ||
      null;

    const tiktokUserId = tiktokUserIdRaw ? String(tiktokUserIdRaw) : null;
    const tiktokSecUid = tiktokSecUidRaw ? String(tiktokSecUidRaw) : null;

    // 项目统一 influencerId：TikTok 场景下使用 tiktokUserId
    const influencerId = tiktokUserId || (influencer.influencerId ? String(influencer.influencerId) : null);
    
    // 粉丝数据
    const followersCount = influencer.followers?.count || 0;
    const followersDisplay = influencer.followers?.display || '0';
    
    // 播放数据
    const avgViews = influencer.views?.avg || 0;
    const viewsDisplay = influencer.views?.display || '0';
    
    // 互动数据
    const engagementRate = influencer.engagement?.rate || 0;
    const avgLikes = influencer.engagement?.avgLikes || 0;
    const avgComments = influencer.engagement?.avgComments || 0;
    
    // 账户类型
    const accountType = influencer.accountType || '';
    const accountTypes = influencer.accountTypes && Array.isArray(influencer.accountTypes) 
      ? JSON.stringify(influencer.accountTypes) 
      : null;
    
    // 其他数据
    const cpm = influencer.cpm || null;
    const followingCount = influencer.following || null;
    const postsCount = influencer.postsCount || null;
    
    // 完整数据（JSON格式）
    const profileData = influencer.profile_data ? JSON.stringify(influencer.profile_data) : null;
    const influencerEmail = normalizeEmailFromProfile(
      influencer.profile_data?.userInfo?.email || influencer.email || null
    );
    
    // 搜索视频数据（JSON格式）
    const searchVideoData = influencer.search_video_data && Array.isArray(influencer.search_video_data) && influencer.search_video_data.length > 0
      ? JSON.stringify(influencer.search_video_data)
      : null;

    // 是否只更新 profile_data（不更新 search_video_data）
    const updateProfileOnly = options.updateProfileOnly === true;

    // 构建 SQL（根据 updateProfileOnly 决定是否更新 search_video_data）
    let sql;
    if (updateProfileOnly) {
      // 只更新 profile_data，不更新 search_video_data
      sql = `
        INSERT INTO TikTok_influencer (
          influencer_id, tiktok_user_id, tiktok_sec_uid,
          username, display_name, profile_url, avatar_url,
          followers_count, followers_display,
          avg_views, views_display,
          avg_likes, avg_comments, engagement_rate,
          account_type, account_types, bio, verified,
          cpm, country, following_count, posts_count, influencer_email,
          profile_data, search_video_data, last_crawled_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())
        ON DUPLICATE KEY UPDATE
          influencer_id = COALESCE(VALUES(influencer_id), influencer_id),
          tiktok_user_id = COALESCE(VALUES(tiktok_user_id), tiktok_user_id),
          tiktok_sec_uid = COALESCE(VALUES(tiktok_sec_uid), tiktok_sec_uid),
          display_name = VALUES(display_name),
          profile_url = VALUES(profile_url),
          avatar_url = VALUES(avatar_url),
          followers_count = VALUES(followers_count),
          followers_display = VALUES(followers_display),
          avg_views = VALUES(avg_views),
          views_display = VALUES(views_display),
          avg_likes = VALUES(avg_likes),
          avg_comments = VALUES(avg_comments),
          engagement_rate = VALUES(engagement_rate),
          account_type = VALUES(account_type),
          account_types = VALUES(account_types),
          bio = VALUES(bio),
          verified = VALUES(verified),
          cpm = VALUES(cpm),
          country = VALUES(country),
          following_count = VALUES(following_count),
          posts_count = VALUES(posts_count),
          influencer_email = COALESCE(VALUES(influencer_email), influencer_email),
          profile_data = VALUES(profile_data),
          -- search_video_data 不更新，保持原值
          last_crawled_at = NOW(),
          updated_at = NOW()
      `;
    } else {
      // 更新所有字段（包括 search_video_data）
      sql = `
        INSERT INTO TikTok_influencer (
          influencer_id, tiktok_user_id, tiktok_sec_uid,
          username, display_name, profile_url, avatar_url,
          followers_count, followers_display,
          avg_views, views_display,
          avg_likes, avg_comments, engagement_rate,
          account_type, account_types, bio, verified,
          cpm, country, following_count, posts_count, influencer_email,
          profile_data, search_video_data, last_crawled_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())
        ON DUPLICATE KEY UPDATE
          influencer_id = COALESCE(VALUES(influencer_id), influencer_id),
          tiktok_user_id = COALESCE(VALUES(tiktok_user_id), tiktok_user_id),
          tiktok_sec_uid = COALESCE(VALUES(tiktok_sec_uid), tiktok_sec_uid),
          display_name = VALUES(display_name),
          profile_url = VALUES(profile_url),
          avatar_url = VALUES(avatar_url),
          followers_count = VALUES(followers_count),
          followers_display = VALUES(followers_display),
          avg_views = VALUES(avg_views),
          views_display = VALUES(views_display),
          avg_likes = VALUES(avg_likes),
          avg_comments = VALUES(avg_comments),
          engagement_rate = VALUES(engagement_rate),
          account_type = VALUES(account_type),
          account_types = VALUES(account_types),
          bio = VALUES(bio),
          verified = VALUES(verified),
          cpm = VALUES(cpm),
          country = VALUES(country),
          following_count = VALUES(following_count),
          posts_count = VALUES(posts_count),
          influencer_email = COALESCE(VALUES(influencer_email), influencer_email),
          profile_data = VALUES(profile_data),
          search_video_data = VALUES(search_video_data),
          last_crawled_at = NOW(),
          updated_at = NOW()
      `;
    }

    const params = [
      influencerId,
      tiktokUserId,
      tiktokSecUid,
      username,
      displayName,
      profileUrl,
      avatarUrl,
      followersCount,
      followersDisplay,
      avgViews,
      viewsDisplay,
      avgLikes,
      avgComments,
      engagementRate,
      accountType,
      accountTypes,
      bio,
      verified ? 1 : 0,
      cpm,
      country,
      followingCount,
      postsCount,
      influencerEmail,
      profileData,
      searchVideoData
    ];

    const result = await queryTikTok(sql, params);
    
    // 获取插入或更新的 ID
    const getIdSql = `SELECT id FROM TikTok_influencer WHERE username = ?`;
    const rows = await queryTikTok(getIdSql, [username]);
    const id = rows[0]?.id || result.insertId;

    console.log(`[TikTokInfluencerDAO] 保存成功: ${username} (ID: ${id})`);

    await syncTiktokInfluencerGlobalEmail(influencer);

    return {
      success: true,
      id: id,
      message: '保存成功'
    };

  } catch (error) {
    console.error('[TikTokInfluencerDAO] 保存失败:', error);
    return {
      success: false,
      id: null,
      message: error.message
    };
  }
}

/**
 * 批量保存 TikTok 红人数据
 * @param {Array<Object>} influencers - 红人数据数组
 * @returns {Promise<Object>} - 保存结果 {success: number, failed: number, results: Array}
 */
export async function saveTikTokInfluencers(influencers) {
  if (!Array.isArray(influencers) || influencers.length === 0) {
    return {
      success: 0,
      failed: 0,
      results: []
    };
  }

  const results = [];
  let successCount = 0;
  let failedCount = 0;

  for (const influencer of influencers) {
    const result = await saveTikTokInfluencer(influencer);
    results.push({
      username: influencer.username,
      ...result
    });
    
    if (result.success) {
      successCount++;
    } else {
      failedCount++;
    }
  }

  console.log(`[TikTokInfluencerDAO] 批量保存完成: 成功 ${successCount}, 失败 ${failedCount}`);

  return {
    success: successCount,
    failed: failedCount,
    results: results
  };
}

/**
 * 查询 TikTok 红人数据
 * @param {Object} filters - 查询条件
 * @param {string} filters.username - 用户名（精确匹配）
 * @param {string} filters.country - 国家
 * @param {number} filters.minFollowers - 最小粉丝量
 * @param {number} filters.maxFollowers - 最大粉丝量
 * @param {string} filters.accountType - 账户类型
 * @param {number} limit - 返回数量限制
 * @returns {Promise<Array>} - 红人数据数组
 */
export async function queryTikTokInfluencers(filters = {}, limit = 100) {
  try {
    let sql = `SELECT * FROM TikTok_influencer WHERE 1=1`;
    const params = [];

    if (filters.username) {
      sql += ` AND username = ?`;
      params.push(filters.username.replace(/^@/, ''));
    }

    if (filters.country) {
      sql += ` AND country = ?`;
      params.push(filters.country);
    }

    if (filters.minFollowers !== undefined) {
      sql += ` AND followers_count >= ?`;
      params.push(filters.minFollowers);
    }

    if (filters.maxFollowers !== undefined) {
      sql += ` AND followers_count <= ?`;
      params.push(filters.maxFollowers);
    }

    if (filters.accountType) {
      sql += ` AND account_type = ?`;
      params.push(filters.accountType);
    }

    sql += ` ORDER BY followers_count DESC, created_at DESC LIMIT ?`;
    params.push(limit);

    const rows = await queryTikTok(sql, params);

    // 转换数据库行数据为标准化格式
    return rows.map(row => ({
      id: row.id,
      username: `@${row.username}`,
      displayName: row.display_name || row.username,
      profileUrl: row.profile_url,
      avatarUrl: row.avatar_url || '',
      platform: 'TikTok',
      country: row.country || '',
      followers: {
        count: row.followers_count || 0,
        display: row.followers_display || '0'
      },
      views: {
        avg: row.avg_views || 0,
        display: row.views_display || '0'
      },
      engagement: {
        rate: parseFloat(row.engagement_rate) || 0,
        avgLikes: row.avg_likes || 0,
        avgComments: row.avg_comments || 0
      },
      accountType: row.account_type || '',
      accountTypes: row.account_types ? JSON.parse(row.account_types) : [],
      bio: row.bio || '',
      verified: row.verified === 1 || row.verified === true,
      cpm: parseFloat(row.cpm) || 0,
      following: row.following_count || null,
      postsCount: row.posts_count || null,
      dbId: row.id,
      lastCrawledAt: row.last_crawled_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    }));

  } catch (error) {
    console.error('[TikTokInfluencerDAO] 查询失败:', error);
    return [];
  }
}