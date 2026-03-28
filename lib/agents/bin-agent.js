// 主 Agent: Bin（营销机构销售负责人）
import { BaseAgent } from "./base-agent.js";
import { callDeepSeekLLM } from "../utils/llm-client.js";
import { WORKFLOW_STATES, getNextWorkflowState, isCreatingCampaign, getWorkflowStateDescription, isToolAllowedInState, detectStepKeywords, getCurrentStepTask, getFirstIncompleteAgent } from "../utils/workflow-states.js";

export class BinAgent extends BaseAgent {
  constructor() {
    const systemPrompt = `你是 Bin，一名红人营销机构的销售负责人，擅长用中文与广告主沟通，帮助他们设计和拆解 influencer marketing campaign。

你的核心能力：
1. 理解客户需求
2. 引导客户完成 campaign 创建流程
3. 收集和确认 campaign 信息

工作方式：
- 用专业、清晰、可执行的方式与客户沟通
- 当客户提供产品链接时，会先提取产品信息再继续对话
- 当产品信息确认后，主动询问客户 campaign 信息（平台、地区、发布时间段、预算、佣金）
- 当需要生成内容脚本时，会基于产品信息生成脚本和视频

工作流状态说明：
- step_1_product_info：正在确认产品信息
- step_2_campaign_info：正在收集 campaign 信息（平台、地区、发布时间段、预算、佣金）
- step_3_influencer_profile：正在确认红人画像
- step_4_content_requirement：正在确认内容要求
- step_5_publish_confirm：正在确认发布

当工作流状态为 step_2_campaign_info 时，如果客户还没有提供 campaign 信息，你应该主动询问：
"好的，现在我需要了解你的 Campaign 信息：
1. 投放平台：TikTok 或 Instagram（Ins），可以选择一个或多个
2. 投放地区：美国或德国，可以选择一个或多个
3. 发布时间段：例如 2024年3月1日-3月31日
4. 预算：总预算金额（美元）
5. 佣金：给红人的佣金比例（%）"

回答要专业、清晰、可执行，用中文与客户沟通。`;

    super("Bin", systemPrompt);
  }

  /**
   * 跨步回应：判断用户消息是否明确在说「修改/补充」某一类信息（产品、投放、红人画像、内容），若是则返回对应 agent 以便转调
   * @param {Array} messages - 消息历史
   * @param {Object} context - 上下文（含 workflowState）
   * @returns {Promise<string|null>} - "product_info_agent" | "campaign_info_agent" | "influencer_profile_agent" | "content_requirement_agent" | null
   */
  async detectMessageTargetBlock(messages, context = {}) {
    const lastMessage = messages[messages.length - 1]?.content || "";
    const recent = messages.slice(-3).map(m => `${m.role}: ${m.content}`).join("\n");
    const currentStep = context.workflowState || WORKFLOW_STATES.IDLE;

    const prompt = `判断用户最后一条消息是否明确是在「修改或补充」以下某一类信息（而不是在确认当前步骤或闲聊）：

1. 产品信息：改产品链接、换产品、产品信息有误、重新提取产品 等
2. 投放/Campaign 信息：改预算、改佣金、改平台、改地区、改发布时间、投放信息有误 等
3. 红人画像：改红人画像、调整粉丝量/播放量/账户类型、换一批红人、重新找红人 等
4. 内容脚本：改脚本、改内容要求、重新生成脚本 等

对话最近几条：
${recent}

用户最后一条消息：${lastMessage}

若用户明确是在修改或补充上述某一类，返回对应的 agent（只选一个，选最匹配的）；否则返回 null。
只返回 JSON，不要其他文字：
{ "toolName": "product_info_agent" | "campaign_info_agent" | "influencer_profile_agent" | "content_requirement_agent" | null }`;

    try {
      const llmResponse = await callDeepSeekLLM(
        [{ role: "user", content: prompt }],
        "你是指意图识别专家。只返回 JSON，不要其他文字。"
      );
      const jsonMatch = llmResponse.match(/\{[\s\S]*\}/);
      const parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : {};
      const name = parsed.toolName;
      const allowed = ["product_info_agent", "campaign_info_agent", "influencer_profile_agent", "content_requirement_agent"];
      return allowed.includes(name) ? name : null;
    } catch (e) {
      console.warn("[BinAgent] detectMessageTargetBlock 失败:", e);
      return null;
    }
  }

  /**
   * 根据工具名和消息补全参数（如 product_info_agent 需 productLink）
   * @param {string} toolName - 子 agent 工具名
   * @param {Array} messages - 消息历史
   * @param {Object} context - 上下文
   * @returns {Object} - params 对象
   */
  getParamsForTool(toolName, messages, context = {}) {
    const lastMessage = (messages[messages.length - 1]?.content || "").toString();
    if (toolName === "product_info_agent") {
      const urlRegex = /https?:\/\/[^\s]+/g;
      const productLink = lastMessage.match(urlRegex)?.[0];
      return productLink ? { productLink } : {};
    }
    return {};
  }

  /**
   * 按工具名返回简短回复（用于调用子 agent 前的占位话术）
   * @param {string} toolName - 子 agent 工具名
   * @returns {string}
   */
  getShortReplyForTool(toolName) {
    const map = {
      product_info_agent: "正在处理产品信息...",
      campaign_info_agent: "正在处理投放信息...",
      influencer_profile_agent: "正在处理红人画像...",
      content_requirement_agent: "正在处理内容脚本...",
      campaign_publish_agent: "正在汇总并确认发布...",
    };
    return map[toolName] || "正在处理你的请求...";
  }

  /**
   * 使用 LLM 判断用户是否在「确认当前阶段」，若是则返回应调用的 agent 名称（供后处理强制调用）
   * @deprecated 已改为按信息是否齐全驱动，不再使用
   * @param {Array} messages - 消息历史
   * @param {Object} context - 上下文（含 workflowState、productInfo、campaignInfo 等）
   * @returns {Promise<{ shouldCall: boolean, toolName: string|null }>}
   */
  async detectConfirmIntentForStage(messages, context = {}) {
    const lastMessage = messages[messages.length - 1]?.content || "";
    const step = context.workflowState || WORKFLOW_STATES.IDLE;
    const conversationHistory = messages.slice(-3).map(m => `${m.role}: ${m.content}`).join("\n");

    const stepDesc = {
      [WORKFLOW_STATES.STEP_1_PRODUCT_INFO]: "确认产品信息",
      [WORKFLOW_STATES.STEP_2_CAMPAIGN_INFO]: "确认 Campaign 投放信息",
      [WORKFLOW_STATES.STEP_3_INFLUENCER_PROFILE]: "确认红人画像",
      [WORKFLOW_STATES.STEP_4_CONTENT_REQUIREMENT]: "确认内容脚本要求",
      [WORKFLOW_STATES.STEP_5_PUBLISH_CONFIRM]: "确认发布",
    };
    const toolMap = {
      [WORKFLOW_STATES.STEP_1_PRODUCT_INFO]: "product_info_agent",
      [WORKFLOW_STATES.STEP_2_CAMPAIGN_INFO]: "campaign_info_agent",
      [WORKFLOW_STATES.STEP_3_INFLUENCER_PROFILE]: "influencer_profile_agent",
      [WORKFLOW_STATES.STEP_4_CONTENT_REQUIREMENT]: "content_requirement_agent",
      [WORKFLOW_STATES.STEP_5_PUBLISH_CONFIRM]: "campaign_publish_agent",
    };

    if (!toolMap[step]) {
      return { shouldCall: false, toolName: null };
    }

    const hasData = {
      [WORKFLOW_STATES.STEP_1_PRODUCT_INFO]: !!context.productInfo,
      [WORKFLOW_STATES.STEP_2_CAMPAIGN_INFO]: !!(context.campaignInfo && context.campaignInfo.platform && context.campaignInfo.region && context.campaignInfo.publishTimeRange != null && context.campaignInfo.budget != null && context.campaignInfo.commission != null),
      [WORKFLOW_STATES.STEP_3_INFLUENCER_PROFILE]: !!context.influencerProfile,
      [WORKFLOW_STATES.STEP_4_CONTENT_REQUIREMENT]: !!context.contentScript,
      [WORKFLOW_STATES.STEP_5_PUBLISH_CONFIRM]: true,
    };
    if (!hasData[step]) {
      return { shouldCall: false, toolName: null };
    }

    const prompt = `判断用户是否在「确认当前阶段」信息。

当前阶段：${step}（${stepDesc[step]}）
对话历史（最近几条）：
${conversationHistory}

用户最后一条消息：${lastMessage}

若用户是在确认当前阶段（如确认、可以、没问题、继续、下一步、好的、行、就这样等），返回应调用的 agent 以便系统执行确认逻辑。
若用户是在提供新信息、要求修改、或只是闲聊，返回 null。

只返回 JSON，不要其他文字：
{ "toolName": "product_info_agent" | "campaign_info_agent" | "influencer_profile_agent" | "content_requirement_agent" | "campaign_publish_agent" | null }`;

    try {
      const llmResponse = await callDeepSeekLLM(
        [{ role: "user", content: prompt }],
        "你是指意图识别专家。只返回 JSON，不要其他文字。"
      );
      const jsonMatch = llmResponse.match(/\{[\s\S]*\}/);
      const parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : {};
      const toolName = parsed.toolName && toolMap[step] === parsed.toolName ? parsed.toolName : null;
      return { shouldCall: !!toolName, toolName };
    } catch (e) {
      console.warn("[BinAgent] detectConfirmIntentForStage 失败:", e);
      return { shouldCall: false, toolName: null };
    }
  }

  /**
   * 处理消息，可能调用子 Agent（使用 LLM 进行意图识别）
   * @param {Array} messages - 消息历史
   * @param {Object} context - 上下文（产品信息等）
   * @returns {Promise<Object>} - { reply: string, toolCall: Object|null }
   */
  async processWithTools(messages, context = {}) {
    try {
      // 创建 campaign 流程：按「信息是否齐全」驱动 —— 每轮固定调用「第一个未齐的块」对应 agent；支持跨步（用户改预算/改产品等）
      if (!context.published && !context.campaignId) {
        const defaultTool = getFirstIncompleteAgent(context);
        const crossStepTool = await this.detectMessageTargetBlock(messages, context);
        const toolName = crossStepTool || defaultTool;
        if (crossStepTool) {
          console.log(`[BinAgent] 跨步回应：用户消息指向 ${crossStepTool}，转调该 agent`);
        } else {
          console.log(`[BinAgent] 按信息齐全驱动：第一未齐块 → ${toolName}`);
        }

        const params = this.getParamsForTool(toolName, messages, context);
        const reply = this.getShortReplyForTool(toolName);
        return {
          reply,
          toolCall: { toolName, params },
          workflowStateUpdate: null,
        };
      }

      // 非创建流程兜底（当前 Router 仅在创建流程调用 Bin，此处保险返回）
      return {
        reply: "请提供产品链接以开始创建 campaign。",
        toolCall: null,
        workflowStateUpdate: null,
      };
    } catch (error) {
      console.error("[BinAgent] 处理失败:", error);
      throw error;
    }
  }

  /**
   * 检查工作流状态是否需要推进
   * 注意：确认判断已由子 agent 处理，此方法不再使用关键词匹配
   * 状态推进由 agent-router 根据子 agent 返回的 isConfirmed 处理
   * @param {Array} messages - 消息历史
   * @param {Object} context - 上下文
   * @returns {Object|null} - 状态更新信息，如果不需要更新则返回 null
   */
  checkWorkflowStateTransition(messages, context) {
    // 确认判断已由子 agent 在 agent-router 中处理
    // 这里不再使用关键词匹配，返回 null
    // 状态推进由 agent-router 根据子 agent 返回的 isConfirmed 处理
    return null;
  }

  /**
   * 降级方案：基于简单规则的意图判断（当 LLM 失败时使用）
   * 检测最可靠的关键词：URL 和 Campaign 相关信息
   */
  fallbackRuleBasedDecision(messages, context) {
    const lastMessage = messages[messages.length - 1]?.content || "";
    const lowerMessage = lastMessage.toLowerCase();
    
    console.log(`[BinAgent] 执行降级规则判断，最后一条消息: ${lastMessage.substring(0, 100)}`);
    console.log(`[BinAgent] 当前上下文:`, {
      hasProductInfo: !!context.productInfo,
      hasCampaignInfo: !!context.campaignInfo,
      hasInfluencerProfile: !!context.influencerProfile,
      hasContentScript: !!context.contentScript
    });

    const currentWorkflowState = context.workflowState || WORKFLOW_STATES.IDLE;

    // 0. 特殊处理：如果状态是 step_3_influencer_profile 且还没有 influencerProfile，自动调用
    if (currentWorkflowState === WORKFLOW_STATES.STEP_3_INFLUENCER_PROFILE && !context.influencerProfile) {
      console.log(`[BinAgent] 降级规则：状态为 step_3_influencer_profile 且无 influencerProfile，自动调用 influencer_profile_agent`);
      return {
        needTool: true,
        toolName: "influencer_profile_agent",
        params: {},
      };
    }

    // 1. 确认类意图由主流程后处理的 LLM 意图识别（detectConfirmIntentForStage）统一处理，此处不再用关键词

    // 2. 检测产品链接（最可靠）
    const urlRegex = /https?:\/\/[^\s]+/g;
    const productLink = lastMessage.match(urlRegex)?.[0];

    if (productLink && !context.productInfo) {
      console.log(`[BinAgent] 降级规则：检测到产品链接，调用 product_info_agent`);
      return {
        needTool: true,
        toolName: "product_info_agent",
        params: { productLink },
      };
    }

    // 3. 检测 Campaign 相关信息关键词（高优先级）
    const campaignKeywords = {
      platform: ["tiktok", "instagram", "ins", "平台", "投放平台"],
      region: ["美国", "德国", "地区", "投放地区"],
      time: ["发布时间", "时间段", "时间范围", "日期", "发布", "时间"],
      budget: ["预算", "金额", "美元", "usd", "$", "费用", "成本"],
      commission: ["佣金", "比例", "百分比", "%", "提成"]
    };
    
    // 检查是否包含任何 Campaign 相关关键词
    const hasCampaignKeywords = 
      campaignKeywords.platform.some(kw => lowerMessage.includes(kw.toLowerCase())) ||
      campaignKeywords.region.some(kw => lowerMessage.includes(kw)) ||
      campaignKeywords.time.some(kw => lowerMessage.includes(kw)) ||
      campaignKeywords.budget.some(kw => lowerMessage.includes(kw.toLowerCase())) ||
      campaignKeywords.commission.some(kw => lowerMessage.includes(kw.toLowerCase())) ||
      /预算|佣金|平台|地区|时间|预算|金额|美元|比例|百分比/i.test(lastMessage);
    
    if (hasCampaignKeywords) {
      // 先验证状态是否允许
      const currentWorkflowState = context.workflowState || WORKFLOW_STATES.IDLE;
      const validation = isToolAllowedInState(currentWorkflowState, "campaign_info_agent");
      
      if (!validation.allowed) {
        // 状态不允许，返回引导消息（不调用工具）
        console.log(`[BinAgent] 降级规则：检测到 Campaign 关键词，但状态不允许调用`);
        const currentTask = getCurrentStepTask(currentWorkflowState);
        const currentStepDesc = getWorkflowStateDescription(currentWorkflowState);
        const detectedStep = detectStepKeywords(lastMessage);
        
        let guideMessage = validation.guideMessage;
        if (detectedStep && detectedStep.step !== currentWorkflowState) {
          const detectedStepDesc = getWorkflowStateDescription(detectedStep.step);
          guideMessage = `我理解你想提供 ${detectedStepDesc} 相关的信息，但我们需要一步一步来。\n\n**当前步骤**：${currentStepDesc}\n**当前任务**：${currentTask}\n\n${validation.guideMessage}`;
        } else {
          guideMessage = `我们需要一步一步来完成 campaign 创建流程。\n\n**当前步骤**：${currentStepDesc}\n**当前任务**：${currentTask}\n\n${validation.guideMessage}`;
        }
        
        // 返回一个特殊标记，表示需要引导
        return {
          needTool: false,
          toolName: null,
          params: null,
          guideMessage: guideMessage
        };
      }
      
      // 状态允许，调用工具
      console.log(`[BinAgent] 降级规则：检测到 Campaign 相关信息关键词，调用 campaign_info_agent`);
      return {
        needTool: true,
        toolName: "campaign_info_agent",
        params: {},
      };
    }
    
    // 3. 检测发布确认关键词（在步骤5或步骤4时）
    const publishKeywords = ["发布", "确认发布", "提交", "确认提交", "发布campaign", "确认发布campaign"];
    const hasPublishKeywords = publishKeywords.some(kw => lowerMessage.includes(kw.toLowerCase()));
    
    if (hasPublishKeywords) {
      const currentWorkflowState = context.workflowState || WORKFLOW_STATES.IDLE;
      
      // 如果状态是 step_4_content_requirement 或 step_5_publish_confirm，调用发布 agent
      if (currentWorkflowState === WORKFLOW_STATES.STEP_4_CONTENT_REQUIREMENT || 
          currentWorkflowState === WORKFLOW_STATES.STEP_5_PUBLISH_CONFIRM) {
        console.log(`[BinAgent] 降级规则：检测到发布确认关键词，调用 campaign_publish_agent`);
        return {
          needTool: true,
          toolName: "campaign_publish_agent",
          params: {},
        };
      }
    }

    // 4. 检测红人画像相关信息关键词
    const influencerKeywords = {
      influencer: ["红人", "influencer", "kol", "达人", "博主", "创作者"],
      profile: ["画像", "要求", "推荐", "账户", "账号"],
      followers: ["粉丝", "粉丝量", "follower"],
      content: ["内容类型", "内容"],
      audience: ["受众", "目标受众"]
    };
    
    const hasInfluencerKeywords = 
      influencerKeywords.influencer.some(kw => lowerMessage.includes(kw.toLowerCase())) ||
      influencerKeywords.profile.some(kw => lowerMessage.includes(kw)) ||
      influencerKeywords.followers.some(kw => lowerMessage.includes(kw.toLowerCase())) ||
      influencerKeywords.content.some(kw => lowerMessage.includes(kw)) ||
      influencerKeywords.audience.some(kw => lowerMessage.includes(kw));
    
    if (hasInfluencerKeywords) {
      // 先验证状态是否允许
      const currentWorkflowState = context.workflowState || WORKFLOW_STATES.IDLE;
      const validation = isToolAllowedInState(currentWorkflowState, "influencer_profile_agent");
      
      if (!validation.allowed) {
        // 状态不允许，返回引导消息
        console.log(`[BinAgent] 降级规则：检测到红人画像关键词，但状态不允许调用`);
        const currentTask = getCurrentStepTask(currentWorkflowState);
        const currentStepDesc = getWorkflowStateDescription(currentWorkflowState);
        
        let guideMessage = `我们需要一步一步来完成 campaign 创建流程。\n\n**当前步骤**：${currentStepDesc}\n**当前任务**：${currentTask}\n\n${validation.guideMessage}`;
        
        return {
          needTool: false,
          toolName: null,
          params: null,
          guideMessage: guideMessage
        };
      }
      
      // 状态允许，调用工具
      console.log(`[BinAgent] 降级规则：检测到红人画像相关信息关键词，调用 influencer_profile_agent`);
      return {
        needTool: true,
        toolName: "influencer_profile_agent",
        params: {},
      };
    }

    // 4. 其他情况不调用工具（交给 LLM 处理或用户重试）

    console.log(`[BinAgent] 降级规则：未检测到需要调用工具的情况`);
    return {
      needTool: false,
      toolName: null,
      params: null,
    };
  }
}