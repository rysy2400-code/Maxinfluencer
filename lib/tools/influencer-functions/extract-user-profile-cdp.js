/**
 * 使用 CDP Network 拦截方式提取用户主页数据
 * 拦截 TikTok API 响应，从 JSON 数据中提取用户和视频信息
 */

import {
  BROWSER_STEP_IDS,
  STEP_STATUS,
  createStep
} from '../../utils/browser-steps.js';

/**
 * 从拦截的 API 响应中提取用户信息
 * @param {Object} apiData - 拦截到的 API 数据
 * @returns {Object} 用户信息
 */
function extractUserInfoFromAPI(apiData) {
  const userInfo = {
    username: null,
    displayName: null,
    avatarUrl: null,
    bio: null,
    email: null,
    followers: null,
    following: null,
    likes: null,
    verified: false,
    postsCount: null,
    // 稳定唯一 ID（来自 author）
    userId: null, // TikTok 数字 userId，建议作为项目统一 influencerId
    secUid: null, // TikTok secUid，备用稳定 ID
  };

  // 从 /api/post/item_list/ 响应中提取用户信息
  if (apiData.itemList && apiData.itemList.length > 0) {
    const firstItem = apiData.itemList[0];

    // 提取 author 信息
    if (firstItem.author) {
      const author = firstItem.author;
      userInfo.username = author.uniqueId || null;
      userInfo.displayName = author.nickname || author.nickName || null;
      userInfo.avatarUrl = author.avatarMedium || author.avatarLarger || author.avatarThumb || null;
      userInfo.verified = author.verified || false;
      userInfo.bio = author.signature || null;
      // 稳定唯一 ID
      userInfo.userId = author.id || null;
      userInfo.secUid = author.secUid || null;
    }

    // 提取 authorStats 信息
    if (firstItem.authorStats || firstItem.authorStatsV2) {
      const stats = firstItem.authorStatsV2 || firstItem.authorStats;
      if (stats) {
        userInfo.followers = stats.followerCount ? {
          count: parseInt(stats.followerCount) || 0,
          display: formatNumber(stats.followerCount)
        } : null;

        userInfo.following = stats.followingCount ? {
          count: parseInt(stats.followingCount) || 0,
          display: formatNumber(stats.followingCount)
        } : null;

        userInfo.likes = (stats.heartCount || stats.heart) ? {
          count: parseInt(stats.heartCount || stats.heart) || 0,
          display: formatNumber(stats.heartCount || stats.heart)
        } : null;

        userInfo.postsCount = stats.videoCount ? {
          count: parseInt(stats.videoCount) || 0,
          display: formatNumber(stats.videoCount)
        } : null;
      }
    }
  }

  // 从 bio 中提取 email
  if (userInfo.bio) {
    const emailMatch = userInfo.bio.match(/([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/);
    if (emailMatch) {
      userInfo.email = emailMatch[1];
    }
  }

  return userInfo;
}

/**
 * 从拦截的 API 响应中提取视频列表
 * @param {Object} apiData - 拦截到的 API 数据
 * @param {string} username - 用户名
 * @returns {Array} 视频列表
 */
function extractVideosFromAPI(apiData, username) {
  const videos = [];

  if (!apiData.itemList || !Array.isArray(apiData.itemList)) {
    return videos;
  }

  for (const item of apiData.itemList) {
    const video = {
      videoId: item.id || null,
      videoUrl: item.id ? `https://www.tiktok.com/@${username}/video/${item.id}` : null,
      username,
      caption: null,
      description: item.desc || null,
      hashtags: [],
      mentions: [],
      views: null,
      likes: null,
      comments: null,
      shares: null,
      favorites: null,
      postedTime: null,
      thumbnail: null,
      music: null,
      creator: null
    };

    // 统计数据
    if (item.stats) {
      if (item.stats.playCount) {
        video.views = {
          count: parseInt(item.stats.playCount) || 0,
          display: formatNumber(item.stats.playCount)
        };
      }
      if (item.stats.diggCount) {
        video.likes = {
          count: parseInt(item.stats.diggCount) || 0,
          display: formatNumber(item.stats.diggCount)
        };
      }
      if (item.stats.commentCount) {
        video.comments = {
          count: parseInt(item.stats.commentCount) || 0,
          display: formatNumber(item.stats.commentCount)
        };
      }
      if (item.stats.shareCount) {
        video.shares = {
          count: parseInt(item.stats.shareCount) || 0,
          display: formatNumber(item.stats.shareCount)
        };
      }
      if (item.stats.collectCount) {
        video.favorites = {
          count: parseInt(item.stats.collectCount) || 0,
          display: formatNumber(item.stats.collectCount)
        };
      }
    }

    // 描述 + hashtags / mentions / caption
    if (item.desc) {
      video.description = item.desc;

      const hashtags = item.desc.match(/#[\w\u4e00-\u9fa5]+/g);
      if (hashtags) {
        video.hashtags = [...new Set(hashtags)];
      }

      const mentions = item.desc.match(/@[\w.]+/g);
      if (mentions) {
        video.mentions = [...new Set(mentions)];
      }

      const captionEnd = item.desc.search(/#|@/);
      video.caption = captionEnd > 0 ? item.desc.substring(0, captionEnd).trim() : item.desc;
    }

    // textExtra 再补充 hashtags / mentions
    if (item.textExtra && Array.isArray(item.textExtra)) {
      for (const extra of item.textExtra) {
        if (extra.type === 1 && extra.hashtagName) {
          if (!video.hashtags.includes(extra.hashtagName)) {
            video.hashtags.push(extra.hashtagName);
          }
        } else if (extra.type === 0 && extra.userUniqueId) {
          const mention = `@${extra.userUniqueId}`;
          if (!video.mentions.includes(mention)) {
            video.mentions.push(mention);
          }
        }
      }
    }

    // 发布时间
    if (item.createTime) {
      const ts = parseInt(item.createTime);
      if (ts) {
        video.postedTime = new Date(ts * 1000).toISOString();
      }
    }

    // 缩略图
    if (item.video?.cover) {
      video.thumbnail = item.video.cover;
    } else if (item.video?.dynamicCover) {
      video.thumbnail = item.video.dynamicCover;
    }

    // 音乐
    if (item.music) {
      video.music = {
        title: item.music.title || null,
        authorName: item.music.authorName || null,
        id: item.music.id || null
      };
    }

    // 创作者
    if (item.author) {
      video.creator = {
        username: item.author.uniqueId || null,
        displayName: item.author.nickname || item.author.nickName || null,
        avatarUrl: item.author.avatarMedium || item.author.avatarLarger || null
      };
    }

    videos.push(video);
  }

  return videos;
}

/**
 * 从拦截的 API 响应中提取单个视频详情
 */
function extractVideoDetailFromAPI(apiData, username) {
  if (!apiData.itemInfo || !apiData.itemInfo.itemStruct) {
    return null;
  }

  const item = apiData.itemInfo.itemStruct;
  const video = {
    videoId: item.id || null,
    videoUrl: item.id ? `https://www.tiktok.com/@${username}/video/${item.id}` : null,
    username,
    caption: null,
    description: item.desc || null,
    hashtags: [],
    mentions: [],
    views: null,
    likes: null,
    comments: null,
    shares: null,
    favorites: null,
    postedTime: null,
    thumbnail: null,
    music: null,
    creator: null,
    duration: null,
    videoFileUrl: null,
    width: null,
    height: null
  };

  // 统计
  if (item.stats) {
    if (item.stats.playCount) {
      video.views = {
        count: parseInt(item.stats.playCount) || 0,
        display: formatNumber(item.stats.playCount)
      };
    }
    if (item.stats.diggCount) {
      video.likes = {
        count: parseInt(item.stats.diggCount) || 0,
        display: formatNumber(item.stats.diggCount)
      };
    }
    if (item.stats.commentCount) {
      video.comments = {
        count: parseInt(item.stats.commentCount) || 0,
        display: formatNumber(item.stats.commentCount)
      };
    }
    if (item.stats.shareCount) {
      video.shares = {
        count: parseInt(item.stats.shareCount) || 0,
        display: formatNumber(item.stats.shareCount)
      };
    }
    if (item.stats.collectCount) {
      video.favorites = {
        count: parseInt(item.stats.collectCount) || 0,
        display: formatNumber(item.stats.collectCount)
      };
    }
  }

  // 描述 / hashtags / mentions / caption
  if (item.desc) {
    video.description = item.desc;
    const hashtags = item.desc.match(/#[\w\u4e00-\u9fa5]+/g);
    if (hashtags) {
      video.hashtags = [...new Set(hashtags)];
    }
    const mentions = item.desc.match(/@[\w.]+/g);
    if (mentions) {
      video.mentions = [...new Set(mentions)];
    }
    const captionEnd = item.desc.search(/#|@/);
    video.caption = captionEnd > 0 ? item.desc.substring(0, captionEnd).trim() : item.desc;
  }

  // textExtra
  if (item.textExtra && Array.isArray(item.textExtra)) {
    for (const extra of item.textExtra) {
      if (extra.type === 1 && extra.hashtagName) {
        if (!video.hashtags.includes(extra.hashtagName)) {
          video.hashtags.push(extra.hashtagName);
        }
      } else if (extra.type === 0 && extra.userUniqueId) {
        const mention = `@${extra.userUniqueId}`;
        if (!video.mentions.includes(mention)) {
          video.mentions.push(mention);
        }
      }
    }
  }

  // 发布时间
  if (item.createTime) {
    const ts = parseInt(item.createTime);
    if (ts) {
      video.postedTime = new Date(ts * 1000).toISOString();
    }
  }

  // 视频信息
  if (item.video) {
    video.thumbnail = item.video.cover || item.video.dynamicCover || null;
    video.duration = item.video.duration ? parseInt(item.video.duration) / 1000 : null;
    video.videoFileUrl = item.video.playAddr || item.video.downloadAddr || null;
    video.width = item.video.width || null;
    video.height = item.video.height || null;
  }

  // 创作者
  if (item.author) {
    video.creator = {
      username: item.author.uniqueId || null,
      displayName: item.author.nickname || item.author.nickName || null,
      avatarUrl: item.author.avatarMedium || item.author.avatarLarger || null
    };
  }

  return video;
}

/**
 * 从拦截的 API 响应中提取关注者/关注列表
 */
function extractUserListFromAPI(apiData) {
  const users = [];
  if (!apiData.userList || !Array.isArray(apiData.userList)) {
    return users;
  }

  for (const user of apiData.userList) {
    const u = {
      userId: user.user?.id || user.id || null,
      username: user.user?.uniqueId || user.uniqueId || null,
      displayName: user.user?.nickname || user.user?.nickName || user.nickname || user.nickName || null,
      avatarUrl: user.user?.avatarMedium || user.user?.avatarLarger || user.avatarMedium || user.avatarLarger || null,
      verified: user.user?.verified || user.verified || false,
      bio: user.user?.signature || user.signature || null,
      followers: null,
      following: null,
      likes: null,
      videoCount: null
    };

    const stats = user.user?.stats || user.stats;
    if (stats) {
      if (stats.followerCount) {
        u.followers = {
          count: parseInt(stats.followerCount) || 0,
          display: formatNumber(stats.followerCount)
        };
      }
      if (stats.followingCount) {
        u.following = {
          count: parseInt(stats.followingCount) || 0,
          display: formatNumber(stats.followingCount)
        };
      }
      if (stats.heartCount || stats.heart) {
        u.likes = {
          count: parseInt(stats.heartCount || stats.heart) || 0,
          display: formatNumber(stats.heartCount || stats.heart)
        };
      }
      if (stats.videoCount) {
        u.videoCount = {
          count: parseInt(stats.videoCount) || 0,
          display: formatNumber(stats.videoCount)
        };
      }
    }

    users.push(u);
  }

  return users;
}

/**
 * 格式化数字（将大数字转换为 K/M 格式）
 */
function formatNumber(num) {
  if (typeof num === 'string') {
    return num;
  }
  const n = Number(num) || 0;
  if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
  if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
  return n.toString();
}

/**
 * 报告结构化步骤
 */
function reportStep(onStepUpdate, stepId, status, detail = null, stats = null) {
  if (!onStepUpdate) return;
  try {
    const step = createStep(stepId, status, detail, stats);
    try {
      onStepUpdate({
        type: 'step',
        step: step
      });
    } catch (updateError) {
      if (updateError.code === 'ERR_INVALID_STATE' || updateError.message?.includes('closed')) {
        console.warn(`[extractUserProfileFromPageCDP] SSE 流已关闭，停止发送步骤更新`);
        return;
      }
      throw updateError;
    }
  } catch (error) {
    if (error.code === 'ERR_INVALID_STATE' || error.message?.includes('closed')) {
      console.warn(`[extractUserProfileFromPageCDP] SSE 流已关闭，停止发送步骤更新`);
    } else {
      console.error(`[extractUserProfileFromPageCDP] reportStep 失败:`, error);
    }
  }
}

/**
 * 报告截图（带重试机制，10 秒超时，最多 3 次）
 */
async function reportScreenshot(onStepUpdate, page, stepId, label, maxRetries = 3) {
  if (!onStepUpdate || !page) return;
  if (page.isClosed()) {
    console.warn(`[extractUserProfileFromPageCDP] ⚠️  页面已关闭，无法截图: ${label}`);
    return;
  }

  let lastError = null;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      console.log(`[extractUserProfileFromPageCDP] 📸 开始截图 (尝试 ${attempt}/${maxRetries}): ${label}`);

      try {
        await page.waitForLoadState('domcontentloaded', { timeout: 3000 }).catch(() => {});
      } catch (_) {}

      const screenshot = await Promise.race([
        page.screenshot({
          type: 'jpeg',
          quality: 70,
          fullPage: false
        }),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('截图超时（35秒）')), 35000)
        )
      ]);

      const base64Image = screenshot.toString('base64');
      const dataUrl = `data:image/jpeg;base64,${base64Image}`;

      console.log(`[extractUserProfileFromPageCDP] ✅ 截图完成，发送更新: ${label}`);
      try {
        onStepUpdate({
          type: 'screenshot',
          stepId,
          label,
          image: dataUrl,
          timestamp: new Date().toISOString()
        });
        return;
      } catch (updateError) {
        if (updateError.code === 'ERR_INVALID_STATE' || updateError.message?.includes('closed')) {
          console.warn(`[extractUserProfileFromPageCDP] SSE 流已关闭，停止发送截图`);
          return;
        }
        throw updateError;
      }
    } catch (error) {
      lastError = error;
      const isTimeout = error.message?.includes('超时') || error.message?.includes('Timeout');
      const isPageClosed = page.isClosed();

      if (isPageClosed) {
        console.warn(`[extractUserProfileFromPageCDP] ⚠️  页面已关闭，停止截图重试: ${label}`);
        return;
      }

      if (attempt < maxRetries) {
        const waitTime = isTimeout ? 2000 : 1000;
        console.warn(
          `[extractUserProfileFromPageCDP] ⚠️  截图失败 (尝试 ${attempt}/${maxRetries}): ${error.message}，${waitTime}ms 后重试...`
        );
        await new Promise(resolve => setTimeout(resolve, waitTime));
      } else {
        console.warn(`[extractUserProfileFromPageCDP] ❌ 截图失败（已重试 ${maxRetries} 次）: ${error.message}`);
      }
    }
  }

  if (lastError) {
    console.warn(`[extractUserProfileFromPageCDP] ❌ 截图最终失败: ${lastError.message}`);
  }
}

/**
 * 主函数：使用 CDP 拦截提取用户主页数据
 */
export async function extractUserProfileFromPageCDP(page, username, options = {}) {
  const { onStepUpdate = null, humanLikeBehavior = false } = options;

  const sendStep = (step, message) => {
    try {
      if (onStepUpdate) {
        onStepUpdate({ step, message });
      }
      console.log(`[extractUserProfileFromPageCDP] ${step}: ${message}`);
    } catch (error) {
      if (error.code === 'ERR_INVALID_STATE' || error.message?.includes('closed')) {
        console.warn(`[extractUserProfileFromPageCDP] SSE 流已关闭，停止发送步骤更新`);
      } else {
        console.error(`[extractUserProfileFromPageCDP] 发送步骤更新失败:`, error);
      }
    }
  };

  const interceptedData = {
    userDetail: null,
    itemList: [],
    itemDetail: [],
    followers: null,
    following: null
  };

  const responseHandler = async (response) => {
    const url = response.url();
    const status = response.status();
    if (status >= 300 && status < 400) return; // 重定向响应无 body，跳过

    try {
      if (url.includes('/api/user/detail')) {
        const body = await response.text();
        try {
          const json = JSON.parse(body);
          interceptedData.userDetail = json;
          console.log(`[extractUserProfileFromPageCDP] ✅ 拦截到用户信息 API: ${url}`);
        } catch (e) {
          console.warn(`[extractUserProfileFromPageCDP] 解析用户信息 API 失败: ${e.message}`);
        }
      } else if (url.includes('/api/post/item_list')) {
        const body = await response.text();
        try {
          const json = JSON.parse(body);
          if (json.itemList && Array.isArray(json.itemList)) {
            interceptedData.itemList.push(json);
            console.log(
              `[extractUserProfileFromPageCDP] ✅ 拦截到视频列表 API: ${url} (${json.itemList.length} 个视频)`
            );
          }
        } catch (e) {
          console.warn(`[extractUserProfileFromPageCDP] 解析视频列表 API 失败: ${e.message}`);
        }
      } else if (url.includes('/api/post/item_detail')) {
        const body = await response.text();
        try {
          const json = JSON.parse(body);
          if (json.itemInfo) {
            interceptedData.itemDetail.push(json);
            console.log(
              `[extractUserProfileFromPageCDP] ✅ 拦截到视频详情 API: ${url} (视频ID: ${json.itemInfo?.itemStruct?.id || '未知'})`
            );
          }
        } catch (e) {
          console.warn(`[extractUserProfileFromPageCDP] 解析视频详情 API 失败: ${e.message}`);
        }
      } else if (url.includes('/api/user/followers')) {
        const body = await response.text();
        try {
          const json = JSON.parse(body);
          interceptedData.followers = json;
          const count = json.userList?.length || 0;
          console.log(
            `[extractUserProfileFromPageCDP] ✅ 拦截到关注者列表 API: ${url} (${count} 个关注者)`
          );
        } catch (e) {
          console.warn(`[extractUserProfileFromPageCDP] 解析关注者列表 API 失败: ${e.message}`);
        }
      } else if (url.includes('/api/user/following')) {
        const body = await response.text();
        try {
          const json = JSON.parse(body);
          interceptedData.following = json;
          const count = json.userList?.length || 0;
          console.log(
            `[extractUserProfileFromPageCDP] ✅ 拦截到关注列表 API: ${url} (${count} 个关注)`
          );
        } catch (e) {
          console.warn(`[extractUserProfileFromPageCDP] 解析关注列表 API 失败: ${e.message}`);
        }
      }
    } catch (e) {
      console.warn(`[extractUserProfileFromPageCDP] 处理响应失败: ${e.message}`);
    }
  };

  // 注册监听
  page.on('response', responseHandler);

  // 开始提取
  reportStep(onStepUpdate, BROWSER_STEP_IDS.ENRICH_PROFILES, STEP_STATUS.RUNNING, `正在提取 @${username} 的主页数据...`);
  sendStep('访问主页', `正在访问 @${username} 的主页...`);

  const profileUrl = `https://www.tiktok.com/@${username}`;
  await page.goto(profileUrl, {
    waitUntil: 'domcontentloaded',
    timeout: 30000
  });

  // 初始等待
  const initialWait = humanLikeBehavior ? 2000 + Math.floor(Math.random() * 3000) : 3000;
  sendStep('等待加载', `正在等待页面和 API 响应（${(initialWait / 1000).toFixed(1)}秒）...`);
  await page.waitForTimeout(initialWait);

  await reportScreenshot(onStepUpdate, page, BROWSER_STEP_IDS.ENRICH_PROFILES, `主页加载完成: @${username}`);
  await reportScreenshot(onStepUpdate, page, BROWSER_STEP_IDS.ENRICH_PROFILES, `开始滚动主页: @${username}`);

  // 模拟滚动
  if (humanLikeBehavior) {
    try {
      const mouseX = 300 + Math.floor(Math.random() * 400);
      const mouseY = 300 + Math.floor(Math.random() * 300);
      await page.mouse.move(mouseX, mouseY);
      await page.waitForTimeout(200 + Math.floor(Math.random() * 300));
    } catch (_) {}
  }

  const scrollCount = humanLikeBehavior ? 2 + Math.floor(Math.random() * 4) : 2;
  sendStep('滚动页面', `正在滚动页面触发更多 API 请求（${scrollCount}次）...`);

  for (let i = 0; i < scrollCount; i++) {
    if (humanLikeBehavior) {
      const percentage = 0.3 + Math.random() * 0.5;
      await page.evaluate(p => {
        const h = document.body.scrollHeight;
        const to = h * p;
        window.scrollTo({ top: to, behavior: 'smooth' });
      }, percentage);
    } else {
      await page.evaluate(() => {
        window.scrollTo(0, document.body.scrollHeight);
      });
    }

    const waitTime = humanLikeBehavior
      ? 1000 + Math.floor(Math.random() * 1500)
      : 1500;
    await page.waitForTimeout(waitTime);

    if (humanLikeBehavior && Math.random() < 0.3 && i > 0) {
      await page.evaluate(() => {
        const current = window.pageYOffset || document.documentElement.scrollTop;
        const up = current - (200 + Math.random() * 300);
        window.scrollTo({ top: Math.max(0, up), behavior: 'smooth' });
      });
      await page.waitForTimeout(500 + Math.floor(Math.random() * 500));
    }

    if (humanLikeBehavior && Math.random() < 0.6) {
      const readTime = 500 + Math.floor(Math.random() * 1500);
      await page.waitForTimeout(readTime);
    }

    await reportScreenshot(
      onStepUpdate,
      page,
      BROWSER_STEP_IDS.ENRICH_PROFILES,
      `滚动进度 ${i + 1}/${scrollCount}: @${username}`
    );
  }

  await reportScreenshot(
    onStepUpdate,
    page,
    BROWSER_STEP_IDS.ENRICH_PROFILES,
    `滚动完成（共 ${scrollCount} 次）: @${username}`
  );

  const finalWait = humanLikeBehavior ? 2000 + Math.floor(Math.random() * 3000) : 3000;
  sendStep('等待响应', `正在等待所有 API 响应完成（${(finalWait / 1000).toFixed(1)}秒）...`);
  await page.waitForTimeout(finalWait);

  // 取消监听
  page.off('response', responseHandler);

  await reportScreenshot(
    onStepUpdate,
    page,
    BROWSER_STEP_IDS.ENRICH_PROFILES,
    `开始提取数据: @${username}`
  );

  // 组装数据
  let userInfo = {
    username,
    displayName: null,
    avatarUrl: null,
    bio: null,
    email: null,
    followers: null,
    following: null,
    likes: null,
    verified: false,
    postsCount: null,
    userId: null,
    secUid: null,
  };

  // 如果有 itemList，则优先从中提取用户信息
  if (interceptedData.itemList.length > 0) {
    const firstItemList = interceptedData.itemList[0];
    const extracted = extractUserInfoFromAPI(firstItemList);
    userInfo = {
      ...userInfo,
      ...extracted,
      username: extracted.username || username
    };
  }

  let videos = [];
  for (const itemListData of interceptedData.itemList) {
    const extractedVideos = extractVideosFromAPI(itemListData, userInfo.username || username);
    videos = videos.concat(extractedVideos);
  }

  // 去重，最多 50 条
  const videoMap = new Map();
  for (const v of videos) {
    if (v.videoId && !videoMap.has(v.videoId)) {
      videoMap.set(v.videoId, v);
    }
  }
  videos = Array.from(videoMap.values()).slice(0, 50);

  // item_detail 补充
  const videoDetails = [];
  for (const d of interceptedData.itemDetail) {
    const detail = extractVideoDetailFromAPI(d, userInfo.username || username);
    if (!detail) continue;
    videoDetails.push(detail);
    const idx = videos.findIndex(v => v.videoId === detail.videoId);
    if (idx >= 0) {
      videos[idx] = { ...videos[idx], ...detail };
    } else {
      videos.push(detail);
    }
  }

  const followers = interceptedData.followers
    ? extractUserListFromAPI(interceptedData.followers)
    : [];
  const following = interceptedData.following
    ? extractUserListFromAPI(interceptedData.following)
    : [];

  const validVideos = videos.filter(
    v => v.views || v.likes || v.comments || v.favorites
  );
  const avg = (getter) =>
    validVideos.length > 0
      ? validVideos.reduce((sum, v) => sum + (getter(v) || 0), 0) / validVideos.length
      : null;

  const avgViews = avg(v => v.views?.count);
  const avgLikes = avg(v => v.likes?.count);
  const avgComments = avg(v => v.comments?.count);
  const avgFavorites = avg(v => v.favorites?.count);

  sendStep('完成', `✅ 成功提取用户信息和 ${videos.length} 个视频数据`);
  await reportScreenshot(
    onStepUpdate,
    page,
    BROWSER_STEP_IDS.ENRICH_PROFILES,
    `提取完成: @${username} (${videos.length} 个视频)`
  );

  reportStep(
    onStepUpdate,
    BROWSER_STEP_IDS.ENRICH_PROFILES,
    STEP_STATUS.COMPLETED,
    `成功提取 @${username} 的主页数据: ${videos.length} 个视频`,
    { videos: videos.length }
  );

  return {
    success: true,
    userInfo: {
      ...userInfo,
      profileUrl: `https://www.tiktok.com/@${userInfo.username || username}`
    },
    videos,
    statistics: {
      videoCount: videos.length,
      avgViews: avgViews ? Math.round(avgViews) : null,
      avgLikes: avgLikes ? Math.round(avgLikes) : null,
      avgComments: avgComments ? Math.round(avgComments) : null,
      avgFavorites: avgFavorites ? Math.round(avgFavorites) : null
    },
    missingData: {
      email: !userInfo.email
        ? '邮箱未在 bio 中找到（如果用户没有在 bio 中提供邮箱，则为 null）'
        : null,
      favorites: videos.filter(v => !v.favorites).length > 0
        ? '部分视频的收藏数未提取到'
        : null
    },
    interceptedApis: {
      userDetail: interceptedData.userDetail !== null,
      itemList: interceptedData.itemList.length,
      itemDetail: interceptedData.itemDetail.length,
      followers: interceptedData.followers !== null,
      following: interceptedData.following !== null
    },
    videoDetails,
    followers,
    following
  };
}


