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

const ANALYSIS_SECTION_TITLES = [
  '## 基础数据评估',
  '## 账户类型评估',
  '## 内容质量评估',
  '## 与产品匹配度评估',
];

const ANALYSIS_RETRY_DELAY_MS = 1500;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 是否为技术性分析失败（可重试 / 可用 Markdown 兜底），非业务「不推荐」 */
export function isTechnicalAnalysisFailure(result) {
  if (!result) return true;
  if (result.success === false) return true;
  const reason = String(result.reason || '').trim();
  if (reason === '无法从响应中提取理由') return true;
  if (reason === '分析失败' || reason.startsWith('分析失败:')) return true;
  return false;
}

export function hasFourAnalysisSections(markdown) {
  const text = String(markdown || '').trim();
  if (!text) return false;
  return ANALYSIS_SECTION_TITLES.every((title) => text.includes(title));
}

function extractSectionBody(markdown, sectionTitle) {
  const text = String(markdown || '');
  const start = text.indexOf(sectionTitle);
  if (start === -1) return '';
  const afterTitle = text.slice(start + sectionTitle.length);
  const nextHeading = afterTitle.search(/\n## /);
  return (nextHeading === -1 ? afterTitle : afterTitle.slice(0, nextHeading)).trim();
}

function extractLastSummaryFromSection(sectionBody) {
  const text = String(sectionBody || '');
  if (!text) return '';

  let last = '';
  const inlineRe = /\*\*小结\*\*[：:]\s*\*\*([\s\S]*?)\*\*/g;
  for (const m of text.matchAll(inlineRe)) {
    const captured = (m[1] || '').replace(/\*\*/g, '').trim();
    if (captured) last = captured;
  }
  if (last) return last;

  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!/小结/.test(lines[i])) continue;
    const cleaned = lines[i]
      .replace(/^[-*]\s*/, '')
      .replace(/\*\*/g, '')
      .replace(/^.*?小结[：:]\s*/, '')
      .trim();
    if (cleaned) return cleaned;
  }
  return '';
}

/**
 * 四节画像分析齐全但无 JSON 时，从各节「小结」推断 reason / score / isRecommended
 */
export function fallbackFromMarkdownSummaries(markdown) {
  const analysis = sanitizeAnalysisMarkdownForDisplay(String(markdown || '').trim());
  const summaries = ANALYSIS_SECTION_TITLES.map((title) =>
    extractLastSummaryFromSection(extractSectionBody(analysis, title))
  ).filter(Boolean);

  const matchSummary =
    extractLastSummaryFromSection(
      extractSectionBody(analysis, '## 与产品匹配度评估')
    ) || summaries[summaries.length - 1] || '';

  const combined = summaries.join(' ');
  const reason =
    matchSummary ||
    combined.slice(0, 280) ||
    '根据画像分析四节小结，已生成匹配评估结论。';

  const notRec =
    /不推荐|不建议联系|不建议合作|严重不符|偏差较大|差异明显|差异较大|不匹配|不符合要求|不符合|风险较高|难以支撑|匹配度低|匹配度偏低|匹配度不足|合作风险高|转化风险高/i;
  const strongRec =
    /建议优先|强烈建议|高度匹配|高度契合|高度重合|建议联系|建议合作|建议试投|建议作为|推荐合作|匹配度较高|匹配度优秀|匹配度高|合作潜力大|契合度高|整体匹配度优秀/i;
  const weakRec = /匹配度中等|匹配度一般|部分契合|存在一定|可尝试|试投|中等偏低|潜力有限/i;

  let isRecommended = false;
  let score = 40;

  if (notRec.test(combined)) {
    isRecommended = false;
    score = /严重|极大|完全|显著|明显不符/.test(combined) ? 20 : 32;
  } else if (strongRec.test(combined)) {
    isRecommended = true;
    score = /优秀|强烈|高度|远超|卓越/.test(combined) ? 88 : 72;
  } else if (weakRec.test(combined)) {
    isRecommended = /可尝试|试投|部分/.test(combined);
    score = isRecommended ? 58 : 42;
  } else if (/契合|匹配|合适/.test(matchSummary) && !/风险|偏差|差异|不足/.test(matchSummary)) {
    isRecommended = true;
    score = 55;
  } else {
    isRecommended = false;
    score = 35;
  }

  return {
    success: true,
    isRecommended,
    score,
    reason,
    analysis,
    recoveredFromMarkdown: true,
  };
}

function parseLlmResponse(llmResponse, streamingAnalysis = '') {
  let analysisResult = {
    success: false,
    isRecommended: false,
    score: 0,
    reason: '分析失败',
    analysis: '',
  };

  try {
    let markdownAnalysis = '';
    let jsonStr = '';

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

    if (jsonStr) {
      try {
        const parsed = JSON.parse(jsonStr);
        analysisResult = {
          success: true,
          isRecommended: parsed.isRecommended || false,
          score: parsed.score || 0,
          reason: parsed.reason || '未提供理由',
          analysis: markdownAnalysis || '未提供详细分析',
        };
      } catch {
        const isRecommendedMatch = llmResponse.match(/isRecommended["\s:]*(\w+)/i);
        const scoreMatch = llmResponse.match(/score["\s:]*(\d+)/i);
        const reasonMatch = llmResponse.match(/reason["\s:]*["']([^"']+)["']/i);

        analysisResult = {
          success: true,
          isRecommended: isRecommendedMatch
            ? isRecommendedMatch[1].toLowerCase() === 'true'
            : false,
          score: scoreMatch ? parseInt(scoreMatch[1], 10) : 0,
          reason: reasonMatch ? reasonMatch[1] : '无法从响应中提取理由',
          analysis: sanitizeAnalysisMarkdownForDisplay(
            markdownAnalysis || llmResponse.substring(0, 500)
          ),
        };
      }
    } else {
      const isRecommendedMatch = llmResponse.match(/isRecommended["\s:]*(\w+)/i);
      const scoreMatch = llmResponse.match(/score["\s:]*(\d+)/i);
      const reasonMatch = llmResponse.match(/reason["\s:]*["']([^"']+)["']/i);

      analysisResult = {
        success: true,
        isRecommended: isRecommendedMatch
          ? isRecommendedMatch[1].toLowerCase() === 'true'
          : false,
        score: scoreMatch ? parseInt(scoreMatch[1], 10) : 0,
        reason: reasonMatch ? reasonMatch[1] : '无法从响应中提取理由',
        analysis: sanitizeAnalysisMarkdownForDisplay(
          markdownAnalysis || llmResponse.substring(0, 500)
        ),
      };
    }
  } catch (parseError) {
    console.warn(`[analyzeInfluencerMatch] 解析 LLM 响应失败: ${parseError.message}`);
    console.warn(`[analyzeInfluencerMatch] LLM 响应: ${llmResponse.substring(0, 200)}`);

    const hasRecommended = /推荐|匹配|符合|合适/i.test(llmResponse);
    const hasNotRecommended = /不推荐|不匹配|不符合|不合适/i.test(llmResponse);

    analysisResult = {
      success: true,
      isRecommended: hasRecommended && !hasNotRecommended,
      score: hasRecommended ? 70 : 30,
      reason: hasRecommended
        ? '根据分析，该红人基本匹配要求'
        : '根据分析，该红人不完全匹配要求',
      analysis: sanitizeAnalysisMarkdownForDisplay(
        streamingAnalysis || llmResponse.substring(0, 500)
      ),
    };
  }

  return analysisResult;
}

async function callAnalysisLlm(prompt, { onStreamChunk, llmTimeoutMs }) {
  if (onStreamChunk) {
    return callDeepSeekLLMStream(
      [{ role: 'user', content: prompt }],
      null,
      onStreamChunk,
      { timeoutMs: llmTimeoutMs }
    );
  }
  return callDeepSeekLLM(
    [{ role: 'user', content: prompt }],
    null,
    { timeoutMs: llmTimeoutMs }
  );
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

    const rawGmv = influencer.gmv ?? influencer.affiliateMetrics?.gmv ?? null;
    const gmvNum =
      typeof rawGmv === "number" && Number.isFinite(rawGmv) ? rawGmv : null;
    const gmvDisplay =
      influencer.gmvDisplay ||
      influencer.affiliateMetrics?.gmvDisplay ||
      (gmvNum != null
        ? gmvNum >= 1_000_000
          ? `$${(gmvNum / 1_000_000).toFixed(1)}M`
          : gmvNum >= 1_000
            ? `$${(gmvNum / 1_000).toFixed(1)}K`
            : `$${Math.round(gmvNum).toLocaleString()}`
        : null);
    const rawUnitsSold =
      influencer.unitsSold ??
      influencer.units_sold ??
      influencer.affiliateMetrics?.unitsSold ??
      null;
    const unitsSoldNum =
      typeof rawUnitsSold === "number" && Number.isFinite(rawUnitsSold)
        ? rawUnitsSold
        : rawUnitsSold != null && rawUnitsSold !== ""
          ? Number(rawUnitsSold)
          : null;
    const unitsSoldDisplay =
      influencer.unitsSoldDisplay ||
      influencer.units_sold_display ||
      influencer.affiliateMetrics?.unitsSoldDisplay ||
      null;
    const hasAffiliateCommerce =
      gmvNum != null ||
      gmvDisplay != null ||
      (Number.isFinite(unitsSoldNum) && unitsSoldNum != null) ||
      unitsSoldDisplay != null;
    const gmvPeriodDays =
      influencer.gmvPeriodDays ?? influencer.affiliateMetrics?.gmvPeriodDays ?? 30;

    // 构建分析用的数据摘要（数值型概要 + 完整视频列表）
    const influencerSummary = {
      username: influencer.username,
      displayName: influencer.displayName || influencer.username,
      profileUrl: influencer.profileUrl,
      followers: influencer.followers?.count || influencer.followers_count || 0,
      followersDisplay: influencer.followers?.display || influencer.followers_display || '0',
      bio: influencer.bio || userInfo.bio || '',
      verified: influencer.verified || userInfo.verified || false,
      gmv: gmvNum,
      gmvDisplay,
      unitsSold: Number.isFinite(unitsSoldNum) ? unitsSoldNum : null,
      unitsSoldDisplay,
      gmvPeriodDays,
      hasAffiliateCommerce,
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

    const followerText = (() => {
      const fr = influencerProfile.followerRange;
      if (fr != null && String(fr).trim() !== "") return String(fr).trim();
      const min = influencerProfile.minFollowers;
      const max = influencerProfile.maxFollowers;
      if (min != null || max != null) {
        return `${min != null ? `${(min / 10000).toFixed(1)}万` : "未指定"} - ${max != null ? `${(max / 10000).toFixed(1)}万` : "未指定"}`;
      }
      return "未指定";
    })();

    // 构建 LLM 分析提示（与 tiktok_campaign.influencer_profile 字段一致）
    const prompt = `你是一位专业的红人营销分析师。请仔细分析以下红人数据，判断该红人是否匹配用户的画像要求。

## 用户画像要求（来自广告主确认的 influencer_profile）
- **粉丝量要求**: ${followerText}
- **播放量要求**: ${influencerProfile.viewRange != null && String(influencerProfile.viewRange).trim() !== "" ? String(influencerProfile.viewRange).trim() : "未指定"}
- **帐号类型 / 内容方向要求**: ${influencerProfile.accountType || "未指定"}

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
- **账户标签**: ${influencerSummary.accountTypes.length > 0 ? influencerSummary.accountTypes.join(', ') : '无'}${influencerSummary.hasAffiliateCommerce ? `
- **GMV（TikTok Shop Affiliate，近 ${influencerSummary.gmvPeriodDays} 天）**: ${influencerSummary.gmvDisplay || (influencerSummary.gmv != null ? `$${influencerSummary.gmv.toLocaleString()}` : '未知')}
- **Units sold（成交件数，近 ${influencerSummary.gmvPeriodDays} 天）**: ${influencerSummary.unitsSold != null ? influencerSummary.unitsSold.toLocaleString() : (influencerSummary.unitsSoldDisplay || '未知')}` : ''}

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

请判断该红人是否匹配用户画像。输出分两块，**职责严格分离**（与产品 UI 一一对应）：

### 画像分析（Markdown 正文 → 存入「画像分析」字段，前端直接展示）

- **第一行必须是** \`## 基础数据评估\`，**禁止**开场白、自我介绍或套话。
- 按顺序输出 **4 个二级标题**（字面必须完全一致，便于解析与展示）：
  1. \`## 基础数据评估\`：粉丝量、播放、点赞、评论${influencerSummary.hasAffiliateCommerce ? "、Affiliate GMV、Units sold（若有）" : ""}；本节末一条 **加粗** 小结${influencerSummary.hasAffiliateCommerce ? "；若提供了 GMV / Units sold，需结合带货规模评估商业化能力与预算匹配度" : ""}
  2. \`## 账户类型评估\`：标签、内容主线、与画像差异；本节末一条 **加粗** 小结
  3. \`## 内容质量评估\`：制作、形式、互动；本节末一条 **加粗** 小结
  4. \`## 与产品匹配度评估\`：契合点、风险、合作潜力；本节末一条 **加粗** 小结
- 四节正文 **仅** 包含上述评估内容；**不要**在第四节末写「结论：推荐/不推荐」或重复推荐理由（推荐结论见下方 JSON）。
- **除文末 JSON 块外**，Markdown 中 **不要** 出现任何 \`\`\` 围栏；**禁止**出现「推荐理由」标题或单独一节推荐理由（理由只写在 JSON 的 \`reason\` 字段）。
- **禁止**复述本提示的结构说明（如「画像分析」「机器可读」「JSON 输出」等字样作标题）。

### 推荐理由（JSON → 存入「推荐理由 / analysis_summary」字段）

- 在 **全文最后**，单独一行写 **唯一一个** \`\`\`json 代码块（中间不要放空块）。
- 代码块内 **仅** 合法 JSON，结构如下（字段名英文、值按实际填写）：
\`\`\`json
{"isRecommended":true,"score":85,"reason":"中文 2～3 句，概括推荐/不推荐的核心依据，与四节小结角度一致，勿重复粘贴上文段落"}
\`\`\`
- \`reason\` 即前端「推荐理由」区块正文；\`isRecommended\` 与 \`score\` 供顶栏 badge 与匹配分展示。

### 硬性约束（违反则视为不合格输出）

1. 全文 **恰好一个** \`\`\`json … \`\`\`，且出现在 **最后一行**；其 **上方** 均为四节画像分析 Markdown。
2. 不要出现含「JSON」「json」「格式输出」字样的 Markdown 标题或小标题。
3. 严格对照用户画像、产品、Campaign 评估；不符合时在对应节中明确写出不符合点。`;

    const runAnalysisAttempt = async () => {
      let streamingAnalysis = '';
      const llmResponse = await callAnalysisLlm(prompt, {
        onStreamChunk: onStreamChunk
          ? (chunk) => {
              streamingAnalysis += chunk;
              onStreamChunk(chunk);
            }
          : null,
        llmTimeoutMs,
      });
      return parseLlmResponse(llmResponse, streamingAnalysis);
    };

    let analysisResult = await runAnalysisAttempt();

    if (isTechnicalAnalysisFailure(analysisResult)) {
      console.warn(
        `[analyzeInfluencerMatch] 技术失败，${ANALYSIS_RETRY_DELAY_MS}ms 后重试 @${influencer.username}: ${analysisResult.reason}`
      );
      await sleep(ANALYSIS_RETRY_DELAY_MS);
      analysisResult = await runAnalysisAttempt();
    }

    if (
      isTechnicalAnalysisFailure(analysisResult) &&
      hasFourAnalysisSections(analysisResult.analysis)
    ) {
      console.warn(
        `[analyzeInfluencerMatch] 重试仍失败，从四节小结兜底 @${influencer.username}`
      );
      analysisResult = fallbackFromMarkdownSummaries(analysisResult.analysis);
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

