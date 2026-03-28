// 浏览器操作步骤定义
// 用于统一管理搜索和主页提取过程中的步骤

/**
 * 步骤 ID 常量
 */
export const BROWSER_STEP_IDS = {
  GENERATE_KEYWORDS: 'generate_keywords',
  CONNECT_CHROME: 'connect_chrome',
  SEARCH_VIDEOS: 'search_videos',
  ENRICH_PROFILES: 'enrich_profiles',
  ANALYZE_MATCH: 'analyze_match',
  SAVE_TO_DB: 'save_to_db',
};

/**
 * 步骤配置
 */
export const BROWSER_STEPS = {
  [BROWSER_STEP_IDS.GENERATE_KEYWORDS]: {
    id: BROWSER_STEP_IDS.GENERATE_KEYWORDS,
    label: '生成搜索关键词',
    icon: '🔍',
  },
  [BROWSER_STEP_IDS.CONNECT_CHROME]: {
    id: BROWSER_STEP_IDS.CONNECT_CHROME,
    label: '连接 Chrome',
    icon: '🌐',
  },
  [BROWSER_STEP_IDS.SEARCH_VIDEOS]: {
    id: BROWSER_STEP_IDS.SEARCH_VIDEOS,
    label: '搜索视频',
    icon: '📹',
  },
  [BROWSER_STEP_IDS.ENRICH_PROFILES]: {
    id: BROWSER_STEP_IDS.ENRICH_PROFILES,
    label: '提取红人主页',
    icon: '👤',
  },
  [BROWSER_STEP_IDS.ANALYZE_MATCH]: {
    id: BROWSER_STEP_IDS.ANALYZE_MATCH,
    label: '分析红人匹配度',
    icon: '🔍',
  },
  [BROWSER_STEP_IDS.SAVE_TO_DB]: {
    id: BROWSER_STEP_IDS.SAVE_TO_DB,
    label: '保存到数据库',
    icon: '💾',
  },
};

/**
 * 步骤状态
 */
export const STEP_STATUS = {
  PENDING: 'pending',
  RUNNING: 'running',
  COMPLETED: 'completed',
  FAILED: 'failed',
};

/**
 * 创建步骤对象
 * @param {string} stepId - 步骤 ID
 * @param {string} status - 步骤状态
 * @param {string} detail - 详细信息
 * @param {Object} stats - 统计数据（可选）
 * @returns {Object} 步骤对象
 */
export function createStep(stepId, status, detail = null, stats = null) {
  const stepConfig = BROWSER_STEPS[stepId];
  if (!stepConfig) {
    throw new Error(`未知的步骤 ID: ${stepId}`);
  }

  return {
    id: stepId,
    label: stepConfig.label,
    icon: stepConfig.icon,
    status,
    detail,
    stats,
    timestamp: new Date().toISOString(),
  };
}

/**
 * 更新步骤列表中的步骤
 * @param {Array} steps - 步骤列表
 * @param {Object} newStep - 新步骤对象
 * @returns {Array} 更新后的步骤列表
 */
export function updateSteps(steps, newStep) {
  const existingIndex = steps.findIndex(s => s.id === newStep.id);
  
  if (existingIndex >= 0) {
    // 更新现有步骤
    const updated = [...steps];
    updated[existingIndex] = {
      ...updated[existingIndex],
      ...newStep,
      timestamp: newStep.timestamp || updated[existingIndex].timestamp,
    };
    return updated;
  } else {
    // 添加新步骤
    return [...steps, newStep];
  }
}

