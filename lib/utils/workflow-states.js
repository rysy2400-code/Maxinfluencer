// 工作流状态常量定义

export const WORKFLOW_STATES = {
  // 空闲状态
  IDLE: "idle",
  
  // 创建 campaign 流程
  CREATING_CAMPAIGN: "creating_campaign",
  STEP_1_PRODUCT_INFO: "step_1_product_info",
  STEP_2_CAMPAIGN_INFO: "step_2_campaign_info",
  STEP_3_INFLUENCER_PROFILE: "step_3_influencer_profile",
  STEP_4_CONTENT_REQUIREMENT: "step_4_content_requirement",
  STEP_5_PUBLISH_CONFIRM: "step_5_publish_confirm",
  
  // 修改 campaign
  MODIFYING_CAMPAIGN: "modifying_campaign",
  
  // 调整执行速度
  ADJUSTING_SPEED: "adjusting_speed",
};

/**
 * 获取「进入该状态时」应调用的子 agent 工具名（用于确认后链式调用下一阶段）
 * @param {string} workflowState - 工作流状态（如 step_2_campaign_info）
 * @returns {string|null} - 工具名，如 "campaign_info_agent"；无需链式则返回 null
 */
export function getAgentForState(workflowState) {
  const stateAgentMap = {
    [WORKFLOW_STATES.STEP_2_CAMPAIGN_INFO]: "campaign_info_agent",
    [WORKFLOW_STATES.STEP_3_INFLUENCER_PROFILE]: "influencer_profile_agent",
    [WORKFLOW_STATES.STEP_4_CONTENT_REQUIREMENT]: "content_requirement_agent",
    [WORKFLOW_STATES.STEP_5_PUBLISH_CONFIRM]: "campaign_publish_agent",
  };
  return stateAgentMap[workflowState] || null;
}

/**
 * 按「信息是否齐全」推导：当前第一个未齐的块对应应调用的子 agent（产品→Campaign→红人画像→内容→发布）
 * 用于 Bin 收束职责：每轮固定调用该 agent，由子 agent 引导用户补全/确认。
 * @param {Object} context - 上下文（含 workflowState）
 * @returns {string} - 工具名，如 "product_info_agent"
 */
export function getFirstIncompleteAgent(context = {}) {
  const state = context.workflowState || WORKFLOW_STATES.IDLE;
  const map = {
    [WORKFLOW_STATES.IDLE]: "product_info_agent",
    [WORKFLOW_STATES.STEP_1_PRODUCT_INFO]: "product_info_agent",
    [WORKFLOW_STATES.STEP_2_CAMPAIGN_INFO]: "campaign_info_agent",
    [WORKFLOW_STATES.STEP_3_INFLUENCER_PROFILE]: "influencer_profile_agent",
    [WORKFLOW_STATES.STEP_4_CONTENT_REQUIREMENT]: "content_requirement_agent",
    [WORKFLOW_STATES.STEP_5_PUBLISH_CONFIRM]: "campaign_publish_agent",
  };
  return map[state] || "product_info_agent";
}

/**
 * 获取工作流状态的下一步
 * @param {string} currentState - 当前状态
 * @returns {string|null} - 下一步状态，如果没有则返回 null
 */
export function getNextWorkflowState(currentState) {
  const stateMap = {
    [WORKFLOW_STATES.STEP_1_PRODUCT_INFO]: WORKFLOW_STATES.STEP_2_CAMPAIGN_INFO,
    [WORKFLOW_STATES.STEP_2_CAMPAIGN_INFO]: WORKFLOW_STATES.STEP_3_INFLUENCER_PROFILE,
    [WORKFLOW_STATES.STEP_3_INFLUENCER_PROFILE]: WORKFLOW_STATES.STEP_4_CONTENT_REQUIREMENT,
    [WORKFLOW_STATES.STEP_4_CONTENT_REQUIREMENT]: WORKFLOW_STATES.STEP_5_PUBLISH_CONFIRM,
    [WORKFLOW_STATES.STEP_5_PUBLISH_CONFIRM]: WORKFLOW_STATES.IDLE,
  };
  
  return stateMap[currentState] || null;
}

/**
 * 检查是否在创建 campaign 流程中
 * @param {string} state - 工作流状态
 * @returns {boolean}
 */
export function isCreatingCampaign(state) {
  return [
    WORKFLOW_STATES.CREATING_CAMPAIGN,
    WORKFLOW_STATES.STEP_1_PRODUCT_INFO,
    WORKFLOW_STATES.STEP_2_CAMPAIGN_INFO,
    WORKFLOW_STATES.STEP_3_INFLUENCER_PROFILE,
    WORKFLOW_STATES.STEP_4_CONTENT_REQUIREMENT,
    WORKFLOW_STATES.STEP_5_PUBLISH_CONFIRM,
  ].includes(state);
}

/**
 * 获取工作流状态的描述（用于日志和调试）
 * @param {string} state - 工作流状态
 * @returns {string}
 */
export function getWorkflowStateDescription(state) {
  const descriptions = {
    [WORKFLOW_STATES.IDLE]: "空闲状态",
    [WORKFLOW_STATES.CREATING_CAMPAIGN]: "创建 campaign 中",
    [WORKFLOW_STATES.STEP_1_PRODUCT_INFO]: "步骤 1 - 确认产品信息",
    [WORKFLOW_STATES.STEP_2_CAMPAIGN_INFO]: "步骤 2 - 确认 campaign 信息",
    [WORKFLOW_STATES.STEP_3_INFLUENCER_PROFILE]: "步骤 3 - 确认红人画像",
    [WORKFLOW_STATES.STEP_4_CONTENT_REQUIREMENT]: "步骤 4 - 确认内容要求",
    [WORKFLOW_STATES.STEP_5_PUBLISH_CONFIRM]: "步骤 5 - 确认发布",
    [WORKFLOW_STATES.MODIFYING_CAMPAIGN]: "修改 campaign",
    [WORKFLOW_STATES.ADJUSTING_SPEED]: "调整执行速度",
  };
  
  return descriptions[state] || `未知状态: ${state}`;
}

/**
 * 检查当前状态是否允许调用指定的工具
 * @param {string} currentState - 当前工作流状态
 * @param {string} toolName - 工具名称
 * @returns {Object} - { allowed: boolean, reason?: string, shouldGuide?: boolean, guideMessage?: string }
 */
export function isToolAllowedInState(currentState, toolName) {
  // 状态-工具映射表
  const stateToolMap = {
    [WORKFLOW_STATES.IDLE]: {
      allowed: ["product_info_agent"],
      message: "请先提供产品链接，我们一步一步来完成 campaign 创建流程。"
    },
    [WORKFLOW_STATES.STEP_1_PRODUCT_INFO]: {
      allowed: ["product_info_agent"], // 允许调用 product_info_agent 来提取或确认产品信息
      message: "请先确认产品信息是否正确，确认后我们继续下一步。"
    },
    [WORKFLOW_STATES.STEP_2_CAMPAIGN_INFO]: {
      allowed: ["campaign_info_agent"],
      message: "请先完成 Campaign 信息收集（平台、地区、预算、佣金、发布时间段），然后我们继续下一步。"
    },
    [WORKFLOW_STATES.STEP_3_INFLUENCER_PROFILE]: {
      allowed: ["influencer_profile_agent"],
      message: "请先确认红人画像要求，然后我们继续下一步。"
    },
    [WORKFLOW_STATES.STEP_4_CONTENT_REQUIREMENT]: {
      allowed: ["content_requirement_agent"],
      message: "请先确认内容要求，然后我们继续下一步。"
    },
    [WORKFLOW_STATES.STEP_5_PUBLISH_CONFIRM]: {
      allowed: ["campaign_publish_agent"], // 允许调用 campaign_publish_agent 来确认发布
      message: "请先确认是否发布 campaign，确认后流程完成。"
    }
  };

  const stateConfig = stateToolMap[currentState];
  if (!stateConfig) {
    // 未知状态，允许调用（可能是 modifying_campaign 或 adjusting_speed）
    return { allowed: true, reason: "未知状态，允许调用" };
  }

  const isAllowed = stateConfig.allowed.includes(toolName);
  
  return {
    allowed: isAllowed,
    reason: isAllowed ? "状态允许" : "状态不允许",
    shouldGuide: !isAllowed,
    guideMessage: stateConfig.message
  };
}

/**
 * 检测用户消息是否提到了某个步骤的关键词
 * @param {string} message - 用户消息
 * @returns {Object|null} - { step: string, keywords: string[] } 或 null
 */
export function detectStepKeywords(message) {
  const stepKeywords = {
    step_1_product_info: ["产品", "链接", "url", "产品信息", "品牌", "产品名"],
    step_2_campaign_info: ["平台", "tiktok", "instagram", "ins", "地区", "美国", "德国", "预算", "佣金", "发布时间", "时间段", "时间范围", "日期", "美元", "usd", "$"],
    step_3_influencer_profile: ["红人", "influencer", "粉丝", "画像", "要求", "推荐", "账户"],
    step_4_content_requirement: ["内容", "脚本", "视频", "内容要求", "内容脚本"],
    step_5_publish_confirm: ["发布", "确认发布", "publish", "提交"]
  };

  const lowerMessage = message.toLowerCase();
  const detectedSteps = [];

  for (const [step, keywords] of Object.entries(stepKeywords)) {
    const matchedKeywords = keywords.filter(kw => lowerMessage.includes(kw.toLowerCase()));
    if (matchedKeywords.length > 0) {
      detectedSteps.push({ step, keywords: matchedKeywords });
    }
  }

  // 返回匹配度最高的步骤（匹配关键词最多的）
  if (detectedSteps.length > 0) {
    detectedSteps.sort((a, b) => b.keywords.length - a.keywords.length);
    return detectedSteps[0];
  }

  return null;
}

/**
 * 获取当前状态应该完成的任务描述
 * @param {string} currentState - 当前工作流状态
 * @returns {string} - 任务描述
 */
export function getCurrentStepTask(currentState) {
  const taskMap = {
    [WORKFLOW_STATES.IDLE]: "提供产品链接",
    [WORKFLOW_STATES.STEP_1_PRODUCT_INFO]: "确认产品信息",
    [WORKFLOW_STATES.STEP_2_CAMPAIGN_INFO]: "提供 Campaign 信息（平台、地区、预算、佣金、发布时间段）",
    [WORKFLOW_STATES.STEP_3_INFLUENCER_PROFILE]: "确认红人画像要求",
    [WORKFLOW_STATES.STEP_4_CONTENT_REQUIREMENT]: "确认内容要求",
    [WORKFLOW_STATES.STEP_5_PUBLISH_CONFIRM]: "确认发布 Campaign"
  };

  return taskMap[currentState] || "继续当前流程";
}

