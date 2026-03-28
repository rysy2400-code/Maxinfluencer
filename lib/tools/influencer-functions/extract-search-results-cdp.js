/**
 * 使用 CDP Network 拦截方式提取搜索页面数据
 * 拦截 TikTok 搜索 API 响应，从 JSON 数据中提取视频和红人信息
 */

/**
 * 从拦截的搜索 API 响应中提取视频列表
 * @param {Object} apiData - 拦截到的 API 数据
 * @returns {Array} 视频列表
 */
function extractVideosFromSearchAPI(apiData) {
  const videos = [];
  
  // 支持多种可能的数据结构
  // 注意：TikTok API 返回的是 item_list（小写+下划线），不是 itemList（驼峰）
  let itemList = null;
  if (apiData.item_list && Array.isArray(apiData.item_list)) {
    // TikTok 搜索 API 实际返回的字段名（小写+下划线）
    itemList = apiData.item_list;
  } else if (apiData.itemList && Array.isArray(apiData.itemList)) {
    // 驼峰命名（兼容）
    itemList = apiData.itemList;
  } else if (apiData.items && Array.isArray(apiData.items)) {
    itemList = apiData.items;
  } else if (apiData.data && Array.isArray(apiData.data)) {
    itemList = apiData.data;
  } else if (apiData.itemInfo && apiData.itemInfo.itemList && Array.isArray(apiData.itemInfo.itemList)) {
    itemList = apiData.itemInfo.itemList;
  }
  
  if (!itemList || itemList.length === 0) {
    return videos;
  }

  for (const item of itemList) {
    // 提取作者信息
    const author = item.author || item.creator || item.user || {};
    const username = author.uniqueId || author.nickname || null;
    
    const video = {
      videoId: item.id || item.videoId || null,
      videoUrl: item.id || item.videoId 
        ? `https://www.tiktok.com/@${username || 'unknown'}/video/${item.id || item.videoId}` 
        : null,
      username: username,
      profileUrl: username ? `https://www.tiktok.com/@${username}` : null,
      caption: null,
      description: item.desc || item.description || item.caption || null,
      hashtags: [],
      mentions: [],
      views: null,
      likes: null,
      comments: null,
      shares: null,
      favorites: null,
      thumbnail: null,
      music: null,
      creator: null,
      postedTime: null
    };
    
    // 提取统计数据
    const stats = item.stats || item.statistics || item.stat || {};
    if (stats.playCount !== undefined || stats.viewCount !== undefined) {
      const playCount = parseInt(stats.playCount || stats.viewCount || 0);
      video.views = {
        count: playCount,
        display: formatNumber(playCount)
      };
    }
    
    if (stats.diggCount !== undefined || stats.likeCount !== undefined) {
      const diggCount = parseInt(stats.diggCount || stats.likeCount || 0);
      video.likes = {
        count: diggCount,
        display: formatNumber(diggCount)
      };
    }
    
    if (stats.commentCount !== undefined) {
      const commentCount = parseInt(stats.commentCount || 0);
      video.comments = {
        count: commentCount,
        display: formatNumber(commentCount)
      };
    }
    
    if (stats.shareCount !== undefined) {
      const shareCount = parseInt(stats.shareCount || 0);
      video.shares = {
        count: shareCount,
        display: formatNumber(shareCount)
      };
    }
    
    if (stats.collectCount !== undefined || stats.favoriteCount !== undefined) {
      const collectCount = parseInt(stats.collectCount || stats.favoriteCount || 0);
      video.favorites = {
        count: collectCount,
        display: formatNumber(collectCount)
      };
    }
    
    // 提取缩略图
    if (item.video) {
      video.thumbnail = item.video.cover || item.video.coverUrl || item.video.thumbnail || null;
    } else if (item.cover) {
      video.thumbnail = item.cover;
    } else if (item.thumbnail) {
      video.thumbnail = item.thumbnail;
    }
    
    // 提取音乐信息
    if (item.music) {
      video.music = {
        title: item.music.title || null,
        author: item.music.authorName || item.music.author || null,
        url: item.music.playUrl || item.music.url || null
      };
    }
    
    // 提取标签和提及
    if (item.textExtra && Array.isArray(item.textExtra)) {
      for (const extra of item.textExtra) {
        if (extra.type === 1 && extra.hashtagName) {
          // 标签
          video.hashtags.push(extra.hashtagName);
        } else if (extra.type === 0 && extra.userUniqueId) {
          // 提及的用户
          video.mentions.push(extra.userUniqueId);
        }
      }
    }
    
    // 提取发布时间
    if (item.createTime) {
      video.postedTime = new Date(item.createTime * 1000).toISOString();
    }
    
    // 提取作者信息（用于红人数据）
    if (author) {
      video.creator = {
        username: author.uniqueId || null,
        displayName: author.nickname || author.nickName || null,
        profileUrl: username ? `https://www.tiktok.com/@${username}` : null,
        avatarUrl: author.avatarMedium || author.avatarLarger || author.avatarThumb || null,
        verified: author.verified || false,
        followers: author.followerCount ? {
          count: parseInt(author.followerCount) || 0,
          display: formatNumber(author.followerCount)
        } : null
      };
    }
    
    videos.push(video);
  }
  
  return videos;
}

/**
 * 从视频列表中提取红人信息（去重）
 * @param {Array} videos - 视频列表
 * @returns {Array} 红人列表
 */
function extractInfluencersFromVideos(videos) {
  const influencerMap = new Map();
  
  for (const video of videos) {
    if (!video.username || !video.creator) continue;
    
    const username = video.username;
    if (influencerMap.has(username)) {
      // 如果已存在，更新数据（保留更完整的信息）
      const existing = influencerMap.get(username);
      if (!existing.followers && video.creator.followers) {
        existing.followers = video.creator.followers;
      }
      if (!existing.verified && video.creator.verified) {
        existing.verified = video.creator.verified;
      }
    } else {
      // 创建新的红人记录
      influencerMap.set(username, {
        username: username,
        displayName: video.creator.displayName || username,
        profileUrl: video.profileUrl || `https://www.tiktok.com/@${username}`,
        avatarUrl: video.creator.avatarUrl || null,
        followers: video.creator.followers || null,
        bio: null,
        verified: video.creator.verified || false,
        platform: 'TikTok'
      });
    }
  }
  
  return Array.from(influencerMap.values());
}

/**
 * 格式化数字（将大数字转换为 K/M 格式）
 */
function formatNumber(num) {
  if (typeof num === 'string') {
    return num;
  }
  if (num >= 1000000) {
    return (num / 1000000).toFixed(1) + 'M';
  }
  if (num >= 1000) {
    return (num / 1000).toFixed(1) + 'K';
  }
  return num.toString();
}

/**
 * 报告结构化步骤（需要在函数内部定义，因为需要动态导入）
 */
async function reportStep(onStepUpdate, stepId, status, detail = null, stats = null) {
  if (!onStepUpdate) {
    console.log(`[extractSearchResultsFromPageCDP] ⚠️  reportStep 跳过: onStepUpdate 为 null`);
    return;
  }
  
  try {
    const { createStep } = await import('../../utils/browser-steps.js');
    const step = createStep(stepId, status, detail, stats);
    console.log(`[extractSearchResultsFromPageCDP] 📝 报告步骤: ${stepId} - ${status} - ${detail}`);
    try {
      onStepUpdate({
        type: 'step',
        step: step
      });
    } catch (updateError) {
      // 静默处理 SSE 流关闭错误
      if (updateError.code === 'ERR_INVALID_STATE' || updateError.message?.includes('closed')) {
        console.warn(`[extractSearchResultsFromPageCDP] SSE 流已关闭，停止发送步骤更新`);
        return; // 提前返回，不抛出错误
      } else {
        throw updateError; // 其他错误继续抛出
      }
    }
  } catch (error) {
    // 静默处理 SSE 流关闭错误
    if (error.code === 'ERR_INVALID_STATE' || error.message?.includes('closed')) {
      console.warn(`[extractSearchResultsFromPageCDP] SSE 流已关闭，停止发送步骤更新`);
    } else {
      console.warn(`[extractSearchResultsFromPageCDP] reportStep 失败: ${error.message}`);
    }
  }
}

/**
 * 报告截图（带重试机制）
 * @param {Function} onStepUpdate - 步骤更新回调
 * @param {Page} page - Playwright 页面对象
 * @param {string} stepId - 关联的步骤 ID
 * @param {string} label - 截图标签
 * @param {number} maxRetries - 最大重试次数（默认3次）
 */
async function reportScreenshot(onStepUpdate, page, stepId, label, maxRetries = 3) {
  if (!onStepUpdate || !page) {
    console.log(`[extractSearchResultsFromPageCDP] ⚠️  reportScreenshot 跳过: onStepUpdate=${!!onStepUpdate}, page=${!!page}`);
    return;
  }
  
  // 检查页面状态
  if (page.isClosed()) {
    console.warn(`[extractSearchResultsFromPageCDP] ⚠️  页面已关闭，无法截图: ${label}`);
    return;
  }
  
  let lastError = null;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      console.log(`[extractSearchResultsFromPageCDP] 📸 开始截图 (尝试 ${attempt}/${maxRetries}): ${label}`);
      
      // 仅短暂等待 dom 稳定，不等待 networkidle（TikTok 页面持续请求，易导致长时间阻塞）
      try {
        await page.waitForLoadState('domcontentloaded', { timeout: 3000 }).catch(() => {});
      } catch (e) {}
      
      // 截图超时 35 秒（TikTok 页面较重；若仍超时则跳过截图，不阻塞主流程）
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
      
      console.log(`[extractSearchResultsFromPageCDP] ✅ 截图完成，发送更新: ${label}`);
      try {
        onStepUpdate({
          type: 'screenshot',
          stepId: stepId,
          label: label,
          image: dataUrl,
          timestamp: new Date().toISOString()
        });
        return; // 成功，退出函数
      } catch (updateError) {
        // 静默处理 SSE 流关闭错误
        if (updateError.code === 'ERR_INVALID_STATE' || updateError.message?.includes('closed')) {
          console.warn(`[extractSearchResultsFromPageCDP] SSE 流已关闭，停止发送截图`);
          return; // 提前返回，不抛出错误
        } else {
          throw updateError; // 其他错误继续抛出
        }
      }
    } catch (error) {
      lastError = error;
      const isTimeout = error.message?.includes('超时') || error.message?.includes('Timeout');
      const isPageClosed = page.isClosed();
      
      if (isPageClosed) {
        console.warn(`[extractSearchResultsFromPageCDP] ⚠️  页面已关闭，停止截图重试: ${label}`);
        return;
      }
      
      if (attempt < maxRetries) {
        const waitTime = isTimeout ? 2000 : 1000; // 超时错误等待更久
        console.warn(`[extractSearchResultsFromPageCDP] ⚠️  截图失败 (尝试 ${attempt}/${maxRetries}): ${error.message}，${waitTime}ms 后重试...`);
        await new Promise(resolve => setTimeout(resolve, waitTime));
      } else {
        console.warn(`[extractSearchResultsFromPageCDP] ❌ 截图失败（已重试 ${maxRetries} 次）: ${error.message}`);
      }
    }
  }
  
  // 所有重试都失败
  if (lastError) {
    console.warn(`[extractSearchResultsFromPageCDP] ❌ 截图最终失败: ${lastError.message}`);
  }
}

/**
 * 使用 CDP Network 拦截方式提取搜索页面数据
 * @param {Page} page - Playwright 页面对象
 * @param {string} keyword - 搜索关键词
 * @param {Object} options - 选项
 * @param {Function} options.onStepUpdate - 步骤更新回调函数
 * @param {boolean} options.humanLikeBehavior - 是否启用人类行为模拟（默认 false）
 * @returns {Promise<Object>} 提取结果
 */
export async function extractSearchResultsFromPageCDP(page, keyword, options = {}) {
  const { 
    onStepUpdate = null, 
    humanLikeBehavior = false,
    scrollRounds = null // 可选：自定义滚动轮数（用于需要更多结果的场景）
  } = options;
  
  console.log(`[extractSearchResultsFromPageCDP] 🔍 开始提取，onStepUpdate=${!!onStepUpdate}`);
  
  // 动态导入 browser-steps 模块
  const { BROWSER_STEP_IDS, STEP_STATUS } = await import('../../utils/browser-steps.js');
  
  const sendStep = (step, message) => {
    if (onStepUpdate) {
      onStepUpdate({ step, message });
    }
    console.log(`[extractSearchResultsFromPageCDP] ${step}: ${message}`);
  };
  
  // 存储拦截到的 API 数据
  const interceptedData = {
    searchApi: [], // 搜索相关的 API 响应
    recommendApi: [], // 推荐相关的 API 响应
    otherApi: [] // 其他可能有用的 API 响应
  };
  
  // 使用 Playwright 的 response 事件监听网络响应
  const responseHandler = async (response) => {
    const url = response.url();
    
    // 拦截搜索相关的 API
    // 主要 API: /api/search/item/full/ - 包含 item_list 数组，有视频数据
    // 其他可能的路径：/api/search/video/, /api/recommend/item_list/ 等
    if (url.includes('/api/search/item/full') || 
        url.includes('/api/search/item/') ||
        url.includes('/api/search/video/') ||
        url.includes('/api/recommend/') ||
        (url.includes('search') && url.includes('/api/'))) {
      try {
        // 重定向响应没有 body，调用 text() 会报错，直接跳过
        const status = response.status();
        if (status >= 300 && status < 400) return;
        const responseBody = await response.text();
        let jsonData = null;
        try {
          jsonData = JSON.parse(responseBody);
          
          // 判断是搜索 API 还是推荐 API
          // 优先拦截 /api/search/item/full/ - 这是主要的搜索 API
          if (url.includes('/api/search/item/full') || url.includes('/api/search/item/')) {
            interceptedData.searchApi.push(jsonData);
            // 注意：API 返回的是 item_list（小写+下划线），不是 itemList
            const itemCount = jsonData.item_list?.length || jsonData.itemList?.length || jsonData.items?.length || jsonData.data?.length || 0;
            const hasMore = jsonData.has_more !== undefined ? jsonData.has_more : jsonData.hasMore;
            const cursor = jsonData.cursor !== undefined ? jsonData.cursor : null;
            console.log(`[extractSearchResultsFromPageCDP] ✅ 拦截到搜索 API: ${url.substring(0, 100)} (${itemCount} 个结果${hasMore ? ', 还有更多' : ''}${cursor !== null ? `, cursor: ${cursor}` : ''})`);
          } else if (url.includes('/api/search/video/')) {
            interceptedData.searchApi.push(jsonData);
            const itemCount = jsonData.item_list?.length || jsonData.itemList?.length || jsonData.items?.length || jsonData.data?.length || 0;
            console.log(`[extractSearchResultsFromPageCDP] ✅ 拦截到视频搜索 API: ${url.substring(0, 100)} (${itemCount} 个结果)`);
          } else if (url.includes('/api/recommend/')) {
            interceptedData.recommendApi.push(jsonData);
            const itemCount = jsonData.item_list?.length || jsonData.itemList?.length || jsonData.items?.length || jsonData.data?.length || 0;
            console.log(`[extractSearchResultsFromPageCDP] ✅ 拦截到推荐 API: ${url.substring(0, 100)} (${itemCount} 个结果)`);
          } else if (url.includes('/api/search/')) {
            // 其他搜索相关的 API
            interceptedData.searchApi.push(jsonData);
            const itemCount = jsonData.item_list?.length || jsonData.itemList?.length || jsonData.items?.length || jsonData.data?.length || 0;
            if (itemCount > 0) {
              console.log(`[extractSearchResultsFromPageCDP] ✅ 拦截到搜索 API: ${url.substring(0, 100)} (${itemCount} 个结果)`);
            }
          }
        } catch (e) {
          console.warn(`[extractSearchResultsFromPageCDP] 解析 API 响应失败: ${e.message}`);
        }
      } catch (e) {
        console.warn(`[extractSearchResultsFromPageCDP] 获取 API 响应失败: ${e.message}`);
      }
    }
  };
  
  // 注册响应监听器
  page.on('response', responseHandler);
  
  // 报告开始搜索
  await reportStep(onStepUpdate, BROWSER_STEP_IDS.SEARCH_VIDEOS, STEP_STATUS.RUNNING, `正在搜索: ${keyword}`);
  
  // 访问搜索页面（带重试机制）
  sendStep('访问搜索页面', `正在访问搜索页面: ${keyword}`);
  const searchUrl = `https://www.tiktok.com/search/video?q=${encodeURIComponent(keyword)}&t=${Date.now()}`;
  
  let gotoSuccess = false;
  let gotoRetries = 0;
  const maxGotoRetries = 3;
  
  while (!gotoSuccess && gotoRetries < maxGotoRetries) {
    try {
      // 检查页面是否仍然有效
      if (page.isClosed()) {
        throw new Error('页面已关闭');
      }
      
      await page.goto(searchUrl, {
        waitUntil: 'domcontentloaded',
        timeout: 60000  // TikTok 加载较慢，60 秒超时
      });
      
      gotoSuccess = true;
    } catch (error) {
      gotoRetries++;
      const isConnectionError = error.message.includes('ERR_CONNECTION_CLOSED') || 
                                error.message.includes('Target closed') ||
                                error.message.includes('页面已关闭');
      
      if (isConnectionError && gotoRetries < maxGotoRetries) {
        console.warn(`[extractSearchResultsFromPageCDP] ⚠️  页面导航失败（尝试 ${gotoRetries}/${maxGotoRetries}）: ${error.message}`);
        sendStep('重试导航', `连接中断，等待 2 秒后重试（${gotoRetries}/${maxGotoRetries}）...`);
        
        // 等待后重试
        await new Promise(resolve => setTimeout(resolve, 2000));
        
        // 如果页面已关闭，尝试从 context 获取新页面
        if (page.isClosed()) {
          try {
            const context = page.context();
            if (context) {
              const pages = context.pages();
              if (pages.length > 0) {
                page = pages[0];
                console.log(`[extractSearchResultsFromPageCDP] ✅ 使用新页面重试`);
              } else {
                page = await context.newPage();
                console.log(`[extractSearchResultsFromPageCDP] ✅ 创建新页面重试`);
              }
              // 重新注册响应监听器
              page.on('response', responseHandler);
            } else {
              throw new Error('无法获取浏览器上下文');
            }
          } catch (reconnectError) {
            console.error(`[extractSearchResultsFromPageCDP] ❌ 重新连接失败:`, reconnectError.message);
            throw new Error(`页面连接失败且无法重新连接: ${error.message}`);
          }
        }
      } else {
        // 非连接错误或已达到最大重试次数
        throw error;
      }
    }
  }
  
  if (!gotoSuccess) {
    throw new Error(`页面导航失败（已重试 ${maxGotoRetries} 次）`);
  }
  
  // 随机等待页面加载和初始 API 响应（2-5秒）
  const initialWaitTime = humanLikeBehavior 
    ? 2000 + Math.floor(Math.random() * 3000) // 2-5秒随机
    : 3000; // 固定3秒
  sendStep('等待加载', `正在等待页面和 API 响应（${(initialWaitTime / 1000).toFixed(1)}秒）...`);
  await page.waitForTimeout(initialWaitTime);
  
  // 页面加载完成后截图
  await reportScreenshot(onStepUpdate, page, BROWSER_STEP_IDS.SEARCH_VIDEOS, '搜索页面加载完成');
  
  // 截图：开始滚动前
  await reportScreenshot(onStepUpdate, page, BROWSER_STEP_IDS.SEARCH_VIDEOS, '开始滚动页面');
  
  // 随机移动鼠标（模拟人类行为）
  if (humanLikeBehavior) {
    try {
      const mouseX = 300 + Math.floor(Math.random() * 400); // 300-700
      const mouseY = 300 + Math.floor(Math.random() * 300); // 300-600
      await page.mouse.move(mouseX, mouseY);
      await page.waitForTimeout(200 + Math.floor(Math.random() * 300)); // 0.2-0.5秒
    } catch (e) {
      // 忽略鼠标移动错误
    }
  }
  
  // 滚动页面触发更多 API 请求（获取更多搜索结果）
  // 如果调用方提供了 scrollRounds，则优先使用；否则使用默认逻辑
  const scrollCount = typeof scrollRounds === "number" && scrollRounds > 0
    ? scrollRounds
    : (humanLikeBehavior 
      ? 5 + Math.floor(Math.random() * 4) // 5-8次随机
      : 6); // 固定6次
  sendStep('滚动页面', `正在滚动页面触发更多 API 请求（${scrollCount}次）...`);
  
  for (let i = 0; i < scrollCount; i++) {
    if (humanLikeBehavior) {
      // 渐进式滚动距离：前几次小滚动，后面逐渐增大
      let scrollPercentage;
      if (i < 2) {
        // 前2次：小滚动（10-30%），模拟仔细浏览顶部内容
        scrollPercentage = 0.1 + Math.random() * 0.2; // 10-30%
      } else if (i < 4) {
        // 中间：中滚动（30-60%），正常浏览
        scrollPercentage = 0.3 + Math.random() * 0.3; // 30-60%
      } else {
        // 后面：大滚动（60-90%），快速浏览
        scrollPercentage = 0.6 + Math.random() * 0.3; // 60-90%
      }
      
      // 滚动速度变化：70%概率使用 smooth，30%概率使用 auto（快速）
      const useSmooth = Math.random() < 0.7;
      const scrollBehavior = useSmooth ? 'smooth' : 'auto';
      
      // 滚动前移动鼠标（模拟鼠标跟随）
      if (Math.random() < 0.6) {
        try {
          const mouseX = 300 + Math.floor(Math.random() * 400);
          const mouseY = 400 + Math.floor(Math.random() * 400);
          await page.mouse.move(mouseX, mouseY);
          await page.waitForTimeout(100 + Math.floor(Math.random() * 200)); // 0.1-0.3秒
        } catch (e) {
          // 忽略鼠标移动错误
        }
      }
      
      // 优先滚动 TikTok 搜索结果实际使用的列表容器，其次才滚 window
      await page.evaluate(({ percentage, behavior }) => {
        const selectors = [
          '[data-e2e="search-result-list"]',
          '[data-e2e="search_video-item-list"]',
          '[class*="SearchResult"]',
          '[class*="search-result"]',
          'main',
          '[role="main"]',
          '.css-1qb12g8-DivContentContainer',
          '[class*="DivContentContainer"]',
          '[class*="ItemContainer"]',
        ];

        const scrollOne = () => {
          const scrollHeight = document.body.scrollHeight;
          const currentScroll = window.pageYOffset || document.documentElement.scrollTop;
          const scrollTo = currentScroll + (scrollHeight * percentage);
          window.scrollTo({
            top: Math.min(scrollTo, scrollHeight),
            behavior,
          });
        };

        // 随机滚动距离（不完全一屏）
        const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 800;
        const scrollAmount = Math.floor(viewportHeight * (0.7 + Math.random() * 0.3));

        for (const sel of selectors) {
          try {
            const el = document.querySelector(sel);
            if (el && el.scrollHeight > el.clientHeight + 32) {
              const before = el.scrollTop;
              el.scrollTo({
                top: before + scrollAmount,
                behavior,
              });
              return;
            }
          } catch (e) {
            // 忽略单个 selector 错误，继续尝试下一个
          }
        }

        // 如果没有找到合适的容器，则退回滚动 window
        scrollOne();
      }, { percentage: scrollPercentage, behavior: scrollBehavior });
    } else {
      // 非 humanLike 模式：优先滚动容器，其次滚 window 到底
      await page.evaluate(() => {
        const selectors = [
          '[data-e2e="search-result-list"]',
          '[data-e2e="search_video-item-list"]',
          '[class*="SearchResult"]',
          '[class*="search-result"]',
          'main',
          '[role="main"]',
          '.css-1qb12g8-DivContentContainer',
          '[class*="DivContentContainer"]',
          '[class*="ItemContainer"]',
        ];

        for (const sel of selectors) {
          try {
            const el = document.querySelector(sel);
            if (el && el.scrollHeight > el.clientHeight + 32) {
              el.scrollTop = el.scrollHeight;
              return;
            }
          } catch (e) {
            // 忽略单个 selector 错误，继续尝试下一个
          }
        }

        // 退回：滚动 window 到底
        window.scrollTo(0, document.body.scrollHeight);
      });
    }
    
    // 根据滚动距离调整等待时间（大滚动等待更久）
    let scrollWaitTime;
    if (humanLikeBehavior) {
      const baseWait = 1000; // 基础等待1秒
      const randomWait = Math.floor(Math.random() * 1500); // 0-1.5秒随机
      scrollWaitTime = baseWait + randomWait; // 1-2.5秒随机
    } else {
      scrollWaitTime = 2000; // 固定2秒
    }
    await page.waitForTimeout(scrollWaitTime);
    
    // 偶尔向上滚动一点（30%概率，模拟回看）
    if (humanLikeBehavior && Math.random() < 0.3 && i > 0) {
      await page.evaluate(() => {
        const currentScroll = window.pageYOffset || document.documentElement.scrollTop;
        const scrollUp = currentScroll - (200 + Math.random() * 300); // 向上滚动200-500px
        window.scrollTo({
          top: Math.max(0, scrollUp),
          behavior: 'smooth'
        });
      });
      await page.waitForTimeout(500 + Math.floor(Math.random() * 500)); // 0.5-1秒
    }
    
    // 随机停留（模拟阅读/观看：60%概率，0.5-3秒）
    if (humanLikeBehavior && Math.random() < 0.6) {
      const readTime = 500 + Math.floor(Math.random() * 2500); // 0.5-3秒随机
      await page.waitForTimeout(readTime);
      
      // 停留时偶尔移动鼠标（模拟查看不同内容）
      if (Math.random() < 0.4) {
        try {
          const mouseX = 200 + Math.floor(Math.random() * 600);
          const mouseY = 200 + Math.floor(Math.random() * 600);
          await page.mouse.move(mouseX, mouseY);
          await page.waitForTimeout(200 + Math.floor(Math.random() * 300));
        } catch (e) {
          // 忽略鼠标移动错误
        }
      }
    }
    
    // 每滚动2次截图一次（避免截图过多）
    if (i > 0 && i % 2 === 0) {
      await reportScreenshot(onStepUpdate, page, BROWSER_STEP_IDS.SEARCH_VIDEOS, `滚动进度 ${i + 1}/${scrollCount}`);
    }
  }
  
  // 滚动完成后截图
  await reportScreenshot(onStepUpdate, page, BROWSER_STEP_IDS.SEARCH_VIDEOS, `滚动完成（共 ${scrollCount} 次）`);
  
  // 随机等待所有 API 响应（2-5秒）
  const finalWaitTime = humanLikeBehavior
    ? 2000 + Math.floor(Math.random() * 3000) // 2-5秒随机
    : 3000; // 固定3秒
  sendStep('等待响应', `正在等待所有 API 响应完成（${(finalWaitTime / 1000).toFixed(1)}秒）...`);
  await page.waitForTimeout(finalWaitTime);
  
  // 搜索完成截图
  const totalVideos = interceptedData.searchApi.reduce((sum, api) => {
    const count = api.item_list?.length || api.itemList?.length || api.items?.length || api.data?.length || 0;
    return sum + count;
  }, 0);
  await reportScreenshot(onStepUpdate, page, BROWSER_STEP_IDS.SEARCH_VIDEOS, `搜索完成，已拦截 ${totalVideos} 个视频`);
  
  // 移除响应监听器
  page.off('response', responseHandler);
  
  // 提取数据前截图
  await reportScreenshot(onStepUpdate, page, BROWSER_STEP_IDS.SEARCH_VIDEOS, '开始提取数据');
  
  // 提取数据
  sendStep('提取数据', '正在从拦截的 API 数据中提取视频和红人信息...');
  
  const allVideos = [];
  const allInfluencers = [];
  
  // 从所有搜索 API 响应中提取视频
  for (const apiData of interceptedData.searchApi) {
    const videos = extractVideosFromSearchAPI(apiData);
    allVideos.push(...videos);
  }
  
  // 如果搜索 API 没有数据，尝试从推荐 API 中提取
  if (allVideos.length === 0) {
    for (const apiData of interceptedData.recommendApi) {
      const videos = extractVideosFromSearchAPI(apiData);
      allVideos.push(...videos);
    }
  }
  
  // 从视频中提取红人信息（去重）
  allInfluencers.push(...extractInfluencersFromVideos(allVideos));
  
  // 去重视频（基于 videoId）
  const uniqueVideos = [];
  const seenVideoIds = new Set();
  for (const video of allVideos) {
    if (video.videoId && !seenVideoIds.has(video.videoId)) {
      seenVideoIds.add(video.videoId);
      uniqueVideos.push(video);
    } else if (!video.videoId) {
      // 如果没有 videoId，也添加（可能是不同的视频）
      uniqueVideos.push(video);
    }
  }
  
  sendStep('完成', `✅ 成功提取 ${uniqueVideos.length} 个视频和 ${allInfluencers.length} 个红人`);
  
  // 报告完成
  await reportStep(onStepUpdate, BROWSER_STEP_IDS.SEARCH_VIDEOS, STEP_STATUS.COMPLETED, 
    `搜索完成: 已提取 ${uniqueVideos.length} 个视频, ${allInfluencers.length} 个红人`,
    { videos: uniqueVideos.length, influencers: allInfluencers.length }
  );
  
  return {
    success: uniqueVideos.length > 0 || allInfluencers.length > 0,
    videos: uniqueVideos,
    influencers: allInfluencers,
    interceptedApis: {
      searchApi: interceptedData.searchApi.length,
      recommendApi: interceptedData.recommendApi.length,
      total: interceptedData.searchApi.length + interceptedData.recommendApi.length
    },
    rawData: {
      searchApi: interceptedData.searchApi,
      recommendApi: interceptedData.recommendApi
    }
  };
}


