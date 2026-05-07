/**
 * 分析红人是否匹配用户画像要求
 * 逐个分析每个红人，实时展示分析过程
 */

import { callDeepSeekLLM, callDeepSeekLLMStream } from '../../utils/llm-client.js';
import { sanitizeAnalysisMarkdownForDisplay } from '../../utils/sanitize-analysis-markdown.js';

/**
 * 从全文里拆出「展示用 Markdown」与 JSON：优先使用**最后一个**可 JSON.parse 的 ```json 块，
 * 避免模型先放空 ```json``` 占位导致非贪婪正则只匹配到空块、正文里仍残留第二段 JSON 围栏。
 */
function splitMarkdownAndJsonFence(llmResponse) {
  const text = llmResponse || '';
  const re = /```json\s*([\s\S]*?)\s*```/g;
  const matches = [...text.matchAll(re)];
  if (!matches.length) return null;

  for (let i = matches.length - 1; i >= 0; i--) {
    const m = matches[i];
    const inner = (m[1] || '').trim();
    if (!inner) continue;
    try {
      JSON.parse(inner);
      return {
        jsonStr: inner,
        markdownAnalysis: text.slice(0, m.index).trim(),
      };
    } catch {
      /* 继续往前找 */
    }
  }
  const last = matches[matches.length - 1];
  return {
    jsonStr: (last[1] || '').trim(),
    markdownAnalysis: text.slice(0, last.index).trim(),
  };
}

/**
 * 分析单个红人是否匹配画像要求
 * @param {Object} influencer - 红人数据（包含 search_video_data 和 profile_data）
 * @param {Object} influencerProfile - 用户画像要求
 * @param {Object} productInfo - 产品信息
 * @param {Object} campaignInfo - Campaign 信息
 * @param {Function} onStreamChunk - 流式输出回调函数（可选）(chunk: string) => void
 * @returns {Promise<Object>} - { success: boolean, isRecommended: boolean, reason: string, score: number, analysis: string }
 */
export async function analyzeInfluencerMatch(influencer, influencerProfile, productInfo, campaignInfo, onStreamChunk = null) {
  try {
    // 单次匹配分析上限（避免流式/网络挂死导致整条 enrich 不结束、last_progress_at 不刷新）
    const rawTimeoutMs = Number(process.env.DEEPSEEK_ANALYSIS_TIMEOUT_MS);
    const llmTimeoutMs =
      Number.isFinite(rawTimeoutMs) && rawTimeoutMs > 0 ? rawTimeoutMs : 120000;

    // 提取红人数据
    const searchVideoData = influencer.search_video_data || [];
    const profileData = influencer.profile_data || {};
    const videos = profileData.videos || [];
    const userInfo = profileData.userInfo || {};
    const statistics = profileData.statistics || {};

    // 构建分析用的数据摘要（数值型概要 + 完整视频列表）
    const influencerSummary = {
      username: influencer.username,
      displayName: influencer.displayName || influencer.username,
      profileUrl: influencer.profileUrl,
      followers: influencer.followers?.count || influencer.followers_count || 0,
      followersDisplay: influencer.followers?.display || influencer.followers_display || '0',
      bio: influencer.bio || userInfo.bio || '',
      verified: influencer.verified || userInfo.verified || false,
      avgViews: statistics.avgViews || influencer.views?.avg || influencer.avg_views || 0,
      avgLikes: statistics.avgLikes || influencer.engagement?.avgLikes || 0,
      avgComments: statistics.avgComments || influencer.engagement?.avgComments || 0,
      postsCount: influencer.postsCount || userInfo.postsCount?.count || 0,
      accountType: influencer.accountType || influencer.account_type || '',
      accountTypes: influencer.accountTypes || influencer.account_types || [],
      searchVideoCount: searchVideoData.length,
      // 不再裁剪样本，保留完整搜索视频列表（只去除无意义空值）
      searchVideoSamples: searchVideoData.map(v => ({
        videoId: v.videoId,
        videoUrl: v.videoUrl,
        description: v.description || v.caption || '',
        views: v.views?.count || v.views,
        likes: v.likes?.count || v.likes,
        comments: v.comments?.count || v.comments,
      })),
      profileVideoCount: videos.length,
      // 不再裁剪样本，保留完整主页视频列表
      profileVideoSamples: videos.map(v => ({
        videoId: v.videoId,
        videoUrl: v.videoUrl,
        description: v.description || '',
        views: v.views?.count || v.views,
        likes: v.likes?.count || v.likes,
        comments: v.comments?.count || v.comments,
      })),
    };

    // 构建 LLM 分析提示
    const prompt = `你是一位专业的红人营销分析师。请仔细分析以下红人数据，判断该红人是否匹配用户的画像要求。

## 用户画像要求
- **账户类型**: ${influencerProfile.accountType || '未指定'}
- **粉丝量范围**: ${influencerProfile.minFollowers ? `${(influencerProfile.minFollowers / 10000).toFixed(1)}万` : '未指定'} - ${influencerProfile.maxFollowers ? `${(influencerProfile.maxFollowers / 10000).toFixed(1)}万` : '未指定'}
- **播放量要求**: ${influencerProfile.viewRange || '未指定'}

## 产品信息
- **品牌**: ${productInfo.brandName || '未指定'}
- **产品名称**: ${productInfo.productName || '未指定'}
- **产品类型**: ${productInfo.productType || '未指定'}

## Campaign 信息
- **平台**: ${campaignInfo.platforms?.join(', ') || '未指定'}
- **目标国家**: ${campaignInfo.countries?.join(', ') || '未指定'}
- **预算**: ${campaignInfo.budget ? `$${campaignInfo.budget}` : '未指定'}
- **佣金**: ${campaignInfo.commission ? `${campaignInfo.commission}%` : '未指定'}

## 红人数据

### 基本信息
- **用户名**: @${influencerSummary.username}
- **显示名**: ${influencerSummary.displayName}
- **主页**: ${influencerSummary.profileUrl}
- **粉丝量**: ${influencerSummary.followersDisplay} (${influencerSummary.followers.toLocaleString()})
- **简介**: ${influencerSummary.bio || '无'}
- **认证状态**: ${influencerSummary.verified ? '✅ 已认证' : '❌ 未认证'}
- **账户类型**: ${influencerSummary.accountType || '未指定'}
- **账户标签**: ${influencerSummary.accountTypes.length > 0 ? influencerSummary.accountTypes.join(', ') : '无'}

### 内容数据
- **视频总数**: ${influencerSummary.postsCount || '未知'}
- **平均播放量**: ${influencerSummary.avgViews ? influencerSummary.avgViews.toLocaleString() : '未知'}
- **平均点赞数**: ${influencerSummary.avgLikes ? influencerSummary.avgLikes.toLocaleString() : '未知'}
- **平均评论数**: ${influencerSummary.avgComments ? influencerSummary.avgComments.toLocaleString() : '未知'}

### 搜索视频数据（${influencerSummary.searchVideoCount} 个）
${influencerSummary.searchVideoSamples.length > 0 
  ? influencerSummary.searchVideoSamples.map((v, i) => 
    `${i + 1}. 视频 ${v.videoId}\n   描述: ${v.description || '无'}\n   播放: ${v.views ? v.views.toLocaleString() : '未知'}\n   点赞: ${v.likes ? v.likes.toLocaleString() : '未知'}`
  ).join('\n')
  : '无搜索视频数据'
}

### 主页视频数据（${influencerSummary.profileVideoCount} 个）
${influencerSummary.profileVideoSamples.length > 0 
  ? influencerSummary.profileVideoSamples.map((v, i) => 
    `${i + 1}. 视频 ${v.videoId}\n   描述: ${v.description || '无'}\n   播放: ${v.views ? v.views.toLocaleString() : '未知'}\n   点赞: ${v.likes ? v.likes.toLocaleString() : '未知'}\n   评论: ${v.comments ? v.comments.toLocaleString() : '未知'}`
  ).join('\n')
  : '无主页视频数据'
}

## 分析任务

请判断该红人是否匹配用户画像，并输出两部分：**(1) 给人读的分析 Markdown**、**(2) 给程序读的 JSON**（二者职责分离，勿混写）。

### (1) 分析正文（Markdown，中文）

- 使用 **4 个二级标题** 组织（顺序固定、标题字面一致，便于阅读）：
  - \`## 基础数据评估\`：粉丝量、播放、点赞、评论及数据小结（含一条 **加粗** 小结句）
  - \`## 账户类型评估\`：标签、内容主线、与画像差异；一条 **加粗** 小结
  - \`## 内容质量评估\`：制作、形式、互动；一条 **加粗** 小结
  - \`## 与产品匹配度评估\`：契合点、风险、合作潜力；一条 **加粗** 小结
- 在第四节末用 1～2 句自然语言收束（可含「结论：推荐/不推荐」），**不要**再单开「最终结论与 JSON」「JSON 输出」「### JSON 格式」等任何标题。
- **除文末第 (2) 步那一个 \`\`\`json 块外**，分析 Markdown 中 **不要** 再出现任何 \`\`\` 围栏（避免空灰框）；**禁止**在 Markdown 里粘贴与 (2) 相同的 JSON 对象或逐字段抄写。

### (2) 机器可读结果（仅一段代码块）

- 在全文 **最后**，单独起一行写 **唯一一个** \`\`\`json 代码块（中间不要先放空块、不要写第二个 json 块）。
- 代码块内 **仅** 合法 JSON，无 Markdown、无注释，结构如下（字段名英文、值按实际填写）：
\`\`\`json
{"isRecommended":true,"score":85,"reason":"中文 2～3 句，与上文小结角度一致即可，勿重复粘贴上文段落"}
\`\`\`

### 硬性约束（违反则视为不合格输出）

1. 全文 **恰好一个** \`\`\`json … \`\`\`，且出现在 **最后一行**；其 **上方** 均为 Markdown 正文。
2. 不要出现含「JSON」「json」「格式输出」字样的 Markdown 标题或小标题。
3. \`reason\` 保持简练；分析细节放在第 (1) 部分各节中。
4. 严格对照用户画像、产品、Campaign 评估；不符合时明确写出不符合点。`;

    // 调用 LLM 进行分析（支持流式输出）
    let llmResponse = '';
    let streamingAnalysis = '';
    
    if (onStreamChunk) {
      // 流式调用
      llmResponse = await callDeepSeekLLMStream(
        [
          {
            role: 'user',
            content: prompt
          }
        ],
        null,
        (chunk) => {
          streamingAnalysis += chunk;
          if (onStreamChunk) {
            onStreamChunk(chunk);
          }
        },
        { timeoutMs: llmTimeoutMs }
      );
    } else {
      // 非流式调用
      llmResponse = await callDeepSeekLLM(
        [
          {
            role: 'user',
            content: prompt
          }
        ],
        null,
        { timeoutMs: llmTimeoutMs }
      );
    }

    // 解析 LLM 响应
    let analysisResult = {
      success: false,
      isRecommended: false,
      score: 0,
      reason: '分析失败',
      analysis: ''
    };

    try {
      // 分离 Markdown 分析与 JSON：勿用 indexOf(jsonStr)，否则正文里若先出现与 JSON 相同的片段会误截断 Markdown。
      let markdownAnalysis = "";
      let jsonStr = "";

      const fenceSplit = splitMarkdownAndJsonFence(llmResponse);
      if (fenceSplit) {
        jsonStr = fenceSplit.jsonStr;
        markdownAnalysis = sanitizeAnalysisMarkdownForDisplay(fenceSplit.markdownAnalysis);
      } else {
        const braceMatch = llmResponse.match(/\{[\s\S]*"isRecommended"[\s\S]*\}/);
        if (braceMatch) {
          jsonStr = braceMatch[0].trim();
          markdownAnalysis = sanitizeAnalysisMarkdownForDisplay(
            llmResponse.slice(0, braceMatch.index).trim()
          );
        } else {
          markdownAnalysis = sanitizeAnalysisMarkdownForDisplay(llmResponse.trim());
        }
      }
      
      // 解析 JSON
      if (jsonStr) {
        try {
          const parsed = JSON.parse(jsonStr);
          analysisResult = {
            success: true,
            isRecommended: parsed.isRecommended || false,
            score: parsed.score || 0,
            reason: parsed.reason || '未提供理由',
            analysis: markdownAnalysis || "未提供详细分析"
          };
        } catch (jsonError) {
          // JSON 解析失败，尝试从文本中提取
          const isRecommendedMatch = llmResponse.match(/isRecommended["\s:]*(\w+)/i);
          const scoreMatch = llmResponse.match(/score["\s:]*(\d+)/i);
          const reasonMatch = llmResponse.match(/reason["\s:]*["']([^"']+)["']/i);
          
          analysisResult = {
            success: true,
            isRecommended: isRecommendedMatch ? isRecommendedMatch[1].toLowerCase() === 'true' : false,
            score: scoreMatch ? parseInt(scoreMatch[1]) : 0,
            reason: reasonMatch ? reasonMatch[1] : '无法从响应中提取理由',
            analysis: sanitizeAnalysisMarkdownForDisplay(
              markdownAnalysis || llmResponse.substring(0, 500)
            ),
          };
        }
      } else {
        // 没有 JSON，尝试从文本中提取信息
        const isRecommendedMatch = llmResponse.match(/isRecommended["\s:]*(\w+)/i);
        const scoreMatch = llmResponse.match(/score["\s:]*(\d+)/i);
        const reasonMatch = llmResponse.match(/reason["\s:]*["']([^"']+)["']/i);
        
        analysisResult = {
          success: true,
          isRecommended: isRecommendedMatch ? isRecommendedMatch[1].toLowerCase() === 'true' : false,
          score: scoreMatch ? parseInt(scoreMatch[1]) : 0,
          reason: reasonMatch ? reasonMatch[1] : '无法从响应中提取理由',
          analysis: sanitizeAnalysisMarkdownForDisplay(
            markdownAnalysis || llmResponse.substring(0, 500)
          ),
        };
      }
    } catch (parseError) {
      console.warn(`[analyzeInfluencerMatch] 解析 LLM 响应失败: ${parseError.message}`);
      console.warn(`[analyzeInfluencerMatch] LLM 响应: ${llmResponse.substring(0, 200)}`);
      
      // 降级处理：从文本中提取关键信息
      const hasRecommended = /推荐|匹配|符合|合适/i.test(llmResponse);
      const hasNotRecommended = /不推荐|不匹配|不符合|不合适/i.test(llmResponse);
      
      analysisResult = {
        success: true,
        isRecommended: hasRecommended && !hasNotRecommended,
        score: hasRecommended ? 70 : 30,
        reason: hasRecommended ? '根据分析，该红人基本匹配要求' : '根据分析，该红人不完全匹配要求',
        analysis: sanitizeAnalysisMarkdownForDisplay(
          streamingAnalysis || llmResponse.substring(0, 500)
        ),
      };
    }

    return analysisResult;

  } catch (error) {
    console.error(`[analyzeInfluencerMatch] 分析失败 (@${influencer.username}):`, error);
    return {
      success: false,
      isRecommended: false,
      score: 0,
      reason: `分析失败: ${error.message}`,
      analysis: ''
    };
  }
}

/**
 * 批量分析红人是否匹配画像要求
 * @param {Array} influencers - 红人数据数组
 * @param {Object} influencerProfile - 用户画像要求
 * @param {Object} productInfo - 产品信息
 * @param {Object} campaignInfo - Campaign 信息
 * @param {Function} onStepUpdate - 步骤更新回调函数（可选）
 * @returns {Promise<Array>} - 分析后的红人数组（包含 isRecommended, reason, score, analysis 字段）
 */
export async function batchAnalyzeInfluencerMatch(influencers, influencerProfile, productInfo, campaignInfo, onStepUpdate = null) {
  // 动态导入 browser-steps 模块
  const { BROWSER_STEP_IDS, STEP_STATUS, createStep, updateSteps } = await import('../../utils/browser-steps.js');
  
  // 报告步骤的辅助函数
  const reportStep = (status, detail, stats = null) => {
    try {
      if (onStepUpdate) {
        const step = createStep(BROWSER_STEP_IDS.ANALYZE_MATCH, status, detail, stats);
        const updatedSteps = updateSteps([], step); // 获取更新后的步骤列表
        onStepUpdate({
          type: 'step',
          step: step
        });
      }
      console.log(`[batchAnalyzeInfluencerMatch] ${detail}`);
    } catch (error) {
      // 静默处理 SSE 流关闭错误
      if (error.code === 'ERR_INVALID_STATE' || error.message?.includes('closed')) {
        console.warn(`[batchAnalyzeInfluencerMatch] SSE 流已关闭，停止发送步骤更新`);
      } else {
        console.error(`[batchAnalyzeInfluencerMatch] 发送步骤更新失败:`, error);
      }
    }
  };

  try {
    // 报告分析开始
    reportStep(STEP_STATUS.RUNNING, `开始分析 ${influencers.length} 个红人是否匹配画像要求...`);

    const analyzedInfluencers = [];
    
    // 逐个分析（不使用 Promise.all，以便实时展示进度）
    for (let i = 0; i < influencers.length; i++) {
      const influencer = influencers[i];
      const progress = `${i + 1}/${influencers.length}`;
      
      // 报告正在分析
      reportStep(STEP_STATUS.RUNNING, 
        `[${progress}] 正在分析 @${influencer.username}：读取主页数据、评估粉丝量、账户类型、内容质量...`,
        { current: i + 1, total: influencers.length, analyzing: influencer.username }
      );
      
      const analysisResult = await analyzeInfluencerMatch(
        influencer,
        influencerProfile,
        productInfo,
        campaignInfo
      );

      // 合并分析结果到红人数据
      const analyzedInfluencer = {
        ...influencer,
        isRecommended: analysisResult.isRecommended,
        recommendationReason: analysisResult.reason,
        recommendationScore: analysisResult.score,
        recommendationAnalysis: analysisResult.analysis,
        analysisSuccess: analysisResult.success
      };

      analyzedInfluencers.push(analyzedInfluencer);

      // 报告分析结果
      const statusText = analysisResult.isRecommended ? '✅ 推荐' : '❌ 不推荐';
      reportStep(STEP_STATUS.RUNNING, 
        `[${progress}] ${statusText} @${influencer.username} - ${analysisResult.reason}`,
        { 
          current: i + 1, 
          total: influencers.length, 
          analyzed: influencer.username,
          isRecommended: analysisResult.isRecommended,
          score: analysisResult.score
        }
      );
      
      // 添加小延迟，避免 API 调用过快
      if (i < influencers.length - 1) {
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    }

    // 统计推荐数量
    const recommendedCount = analyzedInfluencers.filter(inf => inf.isRecommended).length;
    
    // 报告分析完成
    reportStep(STEP_STATUS.COMPLETED, 
      `分析完成：${recommendedCount}/${influencers.length} 个红人推荐`,
      { 
        recommended: recommendedCount, 
        total: influencers.length,
        notRecommended: influencers.length - recommendedCount
      }
    );

    return analyzedInfluencers;

  } catch (error) {
    console.error('[batchAnalyzeInfluencerMatch] 批量分析失败:', error);
    reportStep(STEP_STATUS.FAILED, `批量分析失败: ${error.message}`);
    
    // 返回原始数据（不包含分析结果）
    return influencers.map(inf => ({
      ...inf,
      isRecommended: false,
      recommendationReason: '分析失败',
      recommendationScore: 0,
      analysisSuccess: false
    }));
  }
}

