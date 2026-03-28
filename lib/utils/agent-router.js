// Agent 路由和协调器
import { BinAgent } from "../agents/bin-agent.js";
import { ProductInfoAgent } from "../agents/product-info-agent.js";
import { CampaignInfoAgent } from "../agents/campaign-info-agent.js";
import { InfluencerProfileAgent } from "../agents/influencer-profile-agent.js";
import { ContentRequirementAgent } from "../agents/content-requirement-agent.js";
import { CampaignPublishAgent } from "../agents/campaign-publish-agent.js";
import { CampaignExecutionAgent } from "../agents/campaign-execution-agent.js";
import { WORKFLOW_STATES, getNextWorkflowState, getWorkflowStateDescription, getAgentForState } from "../utils/workflow-states.js";
import { executeCampaignExecutionTool } from "../tools/campaign-execution/campaign-execution-tools.js";

const CAMPAIGN_EXECUTION_TOOLS = new Set([
  "set_report_schedule",
  "set_execution_pacing",
  "modify_campaign",
  "ask_influencer_special_request",
  "get_influencer_special_request_feedback",
  "get_campaign_execution_status",
  "approve_quote",
  "reject_quote",
  "confirm_ship",
  "approve_draft",
  "reject_draft",
  "update_published",
]);

export class AgentRouter {
  constructor() {
    this.binAgent = new BinAgent();
    this.productInfoAgent = new ProductInfoAgent();
    this.campaignInfoAgent = new CampaignInfoAgent();
    this.influencerProfileAgent = new InfluencerProfileAgent();
    this.contentRequirementAgent = new ContentRequirementAgent();
    this.campaignPublishAgent = new CampaignPublishAgent();
    this.campaignExecutionAgent = new CampaignExecutionAgent();
  }

  /**
   * 方案 A 链式调用：确认后同一轮执行下一阶段 agent
   * @param {string} toolName - 下一阶段 agent 工具名
   * @param {Array} messages - 消息历史
   * @param {Object} context - 已更新后的 context（含新 workflowState）
   * @param {Object} thinking - 当前 thinking 对象（会被追加步骤）
   * @param {Function} sendThinkingUpdate - 发送思考更新
   * @returns {Promise<{ reply: string, context: Object, thinking: Object }|null>} - 链式结果，失败或无需链式返回 null
   */
  async runNextStageAgent(toolName, messages, context, thinking, sendThinkingUpdate) {
    const step = {
      agent: "AgentRouter",
      action: "链式调用下一阶段",
      result: `用户确认当前阶段，自动调用 ${toolName}`,
      timestamp: new Date().toISOString(),
    };
    thinking.steps.push(step);
    sendThinkingUpdate({ steps: [...thinking.steps] });

    if (toolName === "campaign_info_agent") {
      const campaignResult = await this.campaignInfoAgent.collectCampaignInfo(messages, context);
      const newContext = {
        ...context,
        campaignInfo: campaignResult.campaignInfo || context.campaignInfo,
        workflowState: context.workflowState,
      };
      thinking.subAgentResult = {
        agent: "CampaignInfoAgent",
        action: "收集Campaign信息（链式）",
        isConfirmed: campaignResult.isConfirmed,
        summary: campaignResult.isConfirmed ? "Campaign信息已确认" : "等待用户提供投放信息",
      };
      sendThinkingUpdate({ subAgentResult: thinking.subAgentResult });
      return { reply: campaignResult.reply, context: newContext, thinking };
    }

    if (toolName === "influencer_profile_agent") {
      if (!thinking.browserSteps) thinking.browserSteps = [];
      if (!thinking.screenshots) thinking.screenshots = [];
      let updateStepsFn = null;
      const getUpdateSteps = async () => {
        if (!updateStepsFn) {
          const module = await import("../utils/browser-steps.js");
          updateStepsFn = module.updateSteps;
        }
        return updateStepsFn;
      };
      const influencerStepUpdate = async (stepUpdate) => {
        try {
          if (stepUpdate.type === "influencerAnalysis" && stepUpdate.influencer) {
            thinking.influencerAnalyses = [...(thinking.influencerAnalyses || []), stepUpdate.influencer];
            sendThinkingUpdate({
              steps: [...thinking.steps],
              browserSteps: [...(thinking.browserSteps || [])],
              screenshots: [],
              influencerAnalyses: [...thinking.influencerAnalyses],
            });
            return;
          }
          if (stepUpdate.type === "step" && stepUpdate.step) {
            const updateSteps = await getUpdateSteps();
            thinking.browserSteps = updateSteps(thinking.browserSteps, stepUpdate.step);
            sendThinkingUpdate({ steps: [...thinking.steps], browserSteps: [...thinking.browserSteps], screenshots: [] });
          } else if (stepUpdate.type === "screenshot") {
            const newShot = {
              stepId: stepUpdate.stepId,
              label: stepUpdate.label,
              image: stepUpdate.image,
              timestamp: stepUpdate.timestamp,
            };
            thinking.screenshots = [newShot];
            sendThinkingUpdate({ type: "screenshot", data: newShot });
            sendThinkingUpdate({ steps: [...thinking.steps], browserSteps: [...thinking.browserSteps], screenshots: [] });
          }
        } catch (e) {
          if (e.code !== "ERR_INVALID_STATE" && !e.message?.includes("closed")) console.error("[AgentRouter] 链式 influencer 步骤更新失败:", e);
        }
      };
      const influencerResult = await this.influencerProfileAgent.recommendInfluencers(messages, context, influencerStepUpdate);
      const isConfirming = influencerResult.isConfirmed || false;
      let nextWorkflowState = context.workflowState;
      if (isConfirming && influencerResult.influencerProfile) {
        nextWorkflowState = WORKFLOW_STATES.STEP_4_CONTENT_REQUIREMENT;
      } else {
        nextWorkflowState = WORKFLOW_STATES.STEP_3_INFLUENCER_PROFILE;
      }
      const newContext = {
        ...context,
        influencerProfile: influencerResult.influencerProfile || context.influencerProfile,
        influencers: influencerResult.influencers || context.influencers,
        workflowState: nextWorkflowState,
      };
      thinking.subAgentResult = {
        agent: "InfluencerProfileAgent",
        action: "推荐红人画像和账户（链式）",
        isConfirmed: influencerResult.isConfirmed,
        influencerCount: influencerResult.influencers?.length || 0,
        summary: `推荐了 ${influencerResult.influencers?.length || 0} 个红人账户`,
      };
      thinking.nextState = nextWorkflowState;
      sendThinkingUpdate({ subAgentResult: thinking.subAgentResult, nextState: thinking.nextState });
      return { reply: influencerResult.reply, context: newContext, thinking };
    }

    if (toolName === "content_requirement_agent") {
      const contentResult = await this.contentRequirementAgent.generateContent(messages, context);
      const isConfirming = contentResult.isConfirmed || false;
      const nextWorkflowState =
        isConfirming && contentResult.contentScript
          ? WORKFLOW_STATES.STEP_5_PUBLISH_CONFIRM
          : WORKFLOW_STATES.STEP_4_CONTENT_REQUIREMENT;
      const newContext = {
        ...context,
        contentScript: contentResult.contentScript,
        video: contentResult.video,
        workflowState: nextWorkflowState,
      };
      thinking.subAgentResult = {
        agent: "ContentRequirementAgent",
        action: "生成内容脚本（链式）",
        isConfirmed: contentResult.isConfirmed,
        summary: contentResult.contentScript ? "内容脚本已生成" : "等待用户确认",
      };
      thinking.nextState = nextWorkflowState;
      sendThinkingUpdate({ subAgentResult: thinking.subAgentResult, nextState: thinking.nextState });
      return { reply: contentResult.reply, context: newContext, thinking };
    }

    if (toolName === "campaign_publish_agent") {
      const publishResult = await this.campaignPublishAgent.confirmAndPublish(messages, context);
      const nextWorkflowState = publishResult.published ? WORKFLOW_STATES.IDLE : WORKFLOW_STATES.STEP_5_PUBLISH_CONFIRM;
      const newContext = {
        ...context,
        published: publishResult.published,
        campaignId: publishResult.campaignId || context.campaignId,
        workflowState: nextWorkflowState,
      };
      thinking.subAgentResult = {
        agent: "CampaignPublishAgent",
        action: "汇总并确认发布（链式）",
        published: publishResult.published,
        summary: publishResult.published ? `Campaign已发布，ID: ${publishResult.campaignId}` : "等待用户确认发布",
      };
      thinking.nextState = nextWorkflowState;
      sendThinkingUpdate({ subAgentResult: thinking.subAgentResult, nextState: thinking.nextState });
      return { reply: publishResult.reply, context: newContext, thinking };
    }

    return null;
  }

  /**
   * 处理用户消息，协调主 Agent 和子 Agent
   * @param {Array} messages - 消息历史
   * @param {Object} context - 上下文（产品信息、内容脚本等）
   * @param {Function} onThinkingUpdate - 思考过程更新回调函数（可选，用于流式传输）
   * @returns {Promise<Object>} - { reply: string, context: Object, thinking?: Object }
   */
  async process(messages, context = {}, onThinkingUpdate = null) {
    try {
      // 初始化思考过程
      const thinking = {
        steps: [],
        currentState: context.workflowState || WORKFLOW_STATES.IDLE,
        nextState: null,
        toolCall: null,
        subAgentResult: null,
        influencerAnalyses: [], // 实时累积的红人分析卡片（每分析完一个就追加）
      };

      // 发送思考过程更新的辅助函数（截图单独以 type:'screenshot' 发送，避免大 payload 导致前端收不到）
      const sendThinkingUpdate = (update) => {
        if (!onThinkingUpdate) return;
        try {
          if (update && update.type === 'screenshot') {
            onThinkingUpdate(update);
            return;
          }
          // 确保 browserSteps、screenshots、influencerAnalyses 始终被包含
          const fullUpdate = {
            ...thinking,
            ...update,
            browserSteps: update.browserSteps !== undefined ? update.browserSteps : (thinking.browserSteps || []),
            screenshots: update.screenshots !== undefined ? update.screenshots : (thinking.screenshots || []),
            influencerAnalyses: update.influencerAnalyses !== undefined ? update.influencerAnalyses : (thinking.influencerAnalyses || []),
          };
          onThinkingUpdate(fullUpdate);
        } catch (error) {
          if (error.code === 'ERR_INVALID_STATE' || error.message?.includes('closed')) {
            console.warn('[AgentRouter] SSE 流已关闭，停止发送更新');
          } else {
            console.error('[AgentRouter] 发送思考更新失败:', error);
          }
        }
      };

      // 1. 发布后走 Campaign Execution Agent，否则走 Bin Agent
      const isExecutionMode = !!(context.published && context.campaignId);
      const binResult = isExecutionMode
        ? await this.campaignExecutionAgent.processWithTools(messages, context)
        : await this.binAgent.processWithTools(messages, context);

      const intentAgentName = isExecutionMode ? "CampaignExecutionAgent" : "BinAgent";
      const intentStep = {
        agent: intentAgentName,
        action: isExecutionMode ? "意图识别" : "路由（按信息齐全+跨步）",
        result: binResult.toolCall ? {
          needTool: true,
          toolName: binResult.toolCall.toolName,
          params: binResult.toolCall.params,
        } : {
          needTool: false,
          reason: "直接回复用户，无需调用工具",
        },
        timestamp: new Date().toISOString(),
      };
      thinking.steps.push(intentStep);
      sendThinkingUpdate({ steps: [...thinking.steps] });

      // 2. 如果需要调用工具，执行子 Agent 或 Campaign Execution 工具
      if (binResult.toolCall) {
        const { toolName, params } = binResult.toolCall;
        const currentWorkflowState = context.workflowState || WORKFLOW_STATES.IDLE;

        // 2a. Campaign 执行阶段工具（汇报、节奏、修改、红人特殊请求等）
        if (CAMPAIGN_EXECUTION_TOOLS.has(toolName)) {
          thinking.toolCall = { toolName, params };
          const routeStep = {
            agent: "AgentRouter",
            action: "路由决策",
            result: `准备执行 ${toolName}`,
            timestamp: new Date().toISOString(),
          };
          thinking.steps.push(routeStep);
          sendThinkingUpdate({ steps: [...thinking.steps], toolCall: thinking.toolCall });

          const execContext = {
            campaignId: context.campaignId,
            influencerAgentClient: context.influencerAgentClient || null,
          };
          const toolResult = await executeCampaignExecutionTool(toolName, params, execContext);
          const reply = await this.campaignExecutionAgent.replyFromToolResult(
            toolName,
            toolResult,
            messages,
            context
          );
          thinking.subAgentResult = {
            agent: "CampaignExecutionAgent",
            action: toolName,
            success: toolResult.success,
            summary: toolResult.message,
          };
          sendThinkingUpdate({ subAgentResult: thinking.subAgentResult });
          return {
            reply,
            context: { ...context },
            thinking,
          };
        }

        thinking.toolCall = { toolName, params };
        const routeStep = {
          agent: "AgentRouter",
          action: "路由决策",
          result: `准备调用 ${toolName}`,
          timestamp: new Date().toISOString(),
        };
        thinking.steps.push(routeStep);
        sendThinkingUpdate({ steps: [...thinking.steps], toolCall: thinking.toolCall });

        if (toolName === "product_info_agent") {
          // 调用产品信息 Agent
          let productResult;
          let actionType;
          
          // 如果已经有产品信息，且用户在确认，调用确认方法
          if (context.productInfo && currentWorkflowState === WORKFLOW_STATES.STEP_1_PRODUCT_INFO) {
            // 用户可能在确认已有的产品信息
            actionType = "确认产品信息";
            const confirmStep = {
              agent: "ProductInfoAgent",
              action: actionType,
              result: "检测用户是否确认已有产品信息",
              timestamp: new Date().toISOString(),
            };
            thinking.steps.push(confirmStep);
            sendThinkingUpdate({ steps: [...thinking.steps] });
            productResult = await this.productInfoAgent.confirmProductInfo(messages, context);
          } else {
            // 提取新的产品信息
            actionType = "提取产品信息";
            const extractStep = {
              agent: "ProductInfoAgent",
              action: actionType,
              result: `从产品链接提取信息: ${params.productLink || "未知"}`,
              timestamp: new Date().toISOString(),
            };
            thinking.steps.push(extractStep);
            sendThinkingUpdate({ steps: [...thinking.steps] });
            productResult = await this.productInfoAgent.extractProductInfo(messages, params);
          }
          
          // 记录子Agent执行结果
          thinking.subAgentResult = {
            agent: "ProductInfoAgent",
            action: actionType,
            isConfirmed: productResult.isConfirmed,
            hasProductInfo: !!productResult.productInfo,
            summary: productResult.productInfo ? 
              `提取到产品: ${productResult.productInfo.productName || "未知"}` : 
              "未提取到产品信息",
          };
          sendThinkingUpdate({ subAgentResult: thinking.subAgentResult });
          
          // 更新上下文和工作流状态
          let nextWorkflowState = currentWorkflowState;
          if (currentWorkflowState === WORKFLOW_STATES.IDLE) {
            nextWorkflowState = WORKFLOW_STATES.STEP_1_PRODUCT_INFO;
          } else if (currentWorkflowState === WORKFLOW_STATES.STEP_1_PRODUCT_INFO) {
            const isConfirming = productResult.isConfirmed || false;
            if (isConfirming && productResult.productInfo) {
              nextWorkflowState = WORKFLOW_STATES.STEP_2_CAMPAIGN_INFO;
              console.log(`[AgentRouter] 用户确认产品信息，状态推进: ${currentWorkflowState} → ${nextWorkflowState}`);
            } else {
              nextWorkflowState = WORKFLOW_STATES.STEP_1_PRODUCT_INFO;
            }
          } else {
            // 跨步回应：从后续步骤回到产品信息，置为 step_1
            nextWorkflowState = WORKFLOW_STATES.STEP_1_PRODUCT_INFO;
          }
          
          const newContext = {
            ...context,
            productInfo: productResult.productInfo || context.productInfo, // 保留已有信息
            workflowState: nextWorkflowState,
          };

          console.log(`[AgentRouter] 工作流状态更新: ${currentWorkflowState} → ${nextWorkflowState} (${getWorkflowStateDescription(nextWorkflowState)})`);

          // 记录状态更新
          thinking.nextState = nextWorkflowState;
          const stateUpdateStep = {
            agent: "AgentRouter",
            action: "状态更新",
            result: `${getWorkflowStateDescription(currentWorkflowState)} → ${getWorkflowStateDescription(nextWorkflowState)}`,
            reason: productResult.isConfirmed ? "用户确认产品信息" : "等待用户确认",
            timestamp: new Date().toISOString(),
          };
          thinking.steps.push(stateUpdateStep);
          sendThinkingUpdate({ 
            steps: [...thinking.steps], 
            nextState: thinking.nextState 
          });

          const nextTool = getAgentForState(nextWorkflowState);
          if (productResult.isConfirmed && nextTool) {
            const chained = await this.runNextStageAgent(nextTool, messages, newContext, thinking, sendThinkingUpdate);
            if (chained) return chained;
          }
          return {
            reply: productResult.reply,
            context: newContext,
            thinking: thinking,
          };
        } else if (toolName === "campaign_info_agent") {
          // 调用 Campaign 信息 Agent
          let campaignResult;
          let actionType;
          
          // 如果已有 campaignInfo 且状态是 step_2_campaign_info，可能是确认场景
          if (context.campaignInfo && currentWorkflowState === WORKFLOW_STATES.STEP_2_CAMPAIGN_INFO) {
            // 检查信息是否完整，如果完整则可能是确认场景
            const campaignInfo = context.campaignInfo;
            const hasAllFields = campaignInfo.platform && 
                                campaignInfo.region && 
                                campaignInfo.publishTimeRange && 
                                campaignInfo.budget !== null && 
                                campaignInfo.budget !== undefined &&
                                campaignInfo.commission !== null && 
                                campaignInfo.commission !== undefined;
            
            if (hasAllFields) {
              // 信息完整，调用确认逻辑（collectCampaignInfo 内部会检测确认）
              actionType = "确认Campaign信息";
              const confirmStep = {
                agent: "CampaignInfoAgent",
                action: actionType,
                result: "检测用户是否确认Campaign信息",
                timestamp: new Date().toISOString(),
              };
              thinking.steps.push(confirmStep);
              sendThinkingUpdate({ steps: [...thinking.steps] });
              campaignResult = await this.campaignInfoAgent.collectCampaignInfo(messages, context);
            } else {
              // 信息不完整，继续收集
              actionType = "收集Campaign信息";
              const collectStep = {
                agent: "CampaignInfoAgent",
                action: actionType,
                result: "从用户消息中提取Campaign信息（平台、地区、预算、佣金、发布时间段）",
                timestamp: new Date().toISOString(),
              };
              thinking.steps.push(collectStep);
              sendThinkingUpdate({ steps: [...thinking.steps] });
              campaignResult = await this.campaignInfoAgent.collectCampaignInfo(messages, context);
            }
          } else {
            // 没有 campaignInfo 或不在 step_2，正常收集
            actionType = "收集Campaign信息";
            const campaignStep = {
              agent: "CampaignInfoAgent",
              action: actionType,
              result: "从用户消息中提取Campaign信息（平台、地区、预算、佣金、发布时间段）",
              timestamp: new Date().toISOString(),
            };
            thinking.steps.push(campaignStep);
            sendThinkingUpdate({ steps: [...thinking.steps] });
            campaignResult = await this.campaignInfoAgent.collectCampaignInfo(messages, context);
          }
          
          // 记录子Agent执行结果
          const campaignInfo = campaignResult.campaignInfo || {};
          thinking.subAgentResult = {
            agent: "CampaignInfoAgent",
            action: actionType || "收集Campaign信息",
            isConfirmed: campaignResult.isConfirmed,
            extractedFields: {
              platform: !!campaignInfo.platform,
              region: !!campaignInfo.region,
              publishTimeRange: !!campaignInfo.publishTimeRange,
              budget: campaignInfo.budget !== null && campaignInfo.budget !== undefined,
              commission: campaignInfo.commission !== null && campaignInfo.commission !== undefined,
            },
            summary: campaignResult.isConfirmed ? "Campaign信息已确认" : "等待用户确认或补充信息",
          };
          sendThinkingUpdate({ subAgentResult: thinking.subAgentResult });
          
          // 更新上下文和工作流状态
          let nextWorkflowState = currentWorkflowState;
          // 检查 campaign 信息是否完整（在外部作用域定义，以便后续使用）
          let hasAllFields = false;
          if (campaignResult.campaignInfo) {
            const campaignInfo = campaignResult.campaignInfo;
            hasAllFields = campaignInfo.platform && 
                          campaignInfo.region && 
                          campaignInfo.publishTimeRange && 
                          campaignInfo.budget !== null && 
                          campaignInfo.budget !== undefined &&
                          campaignInfo.commission !== null && 
                          campaignInfo.commission !== undefined;
          }
          
          if (currentWorkflowState === WORKFLOW_STATES.STEP_2_CAMPAIGN_INFO) {
            // 如果已经在步骤 2，检查是否确认
            const isConfirming = campaignResult.isConfirmed || false;
            if (isConfirming && campaignResult.campaignInfo) {
              if (hasAllFields) {
                // 用户确认 Campaign 信息且信息完整，推进到步骤 3
                nextWorkflowState = WORKFLOW_STATES.STEP_3_INFLUENCER_PROFILE;
                console.log(`[AgentRouter] 用户确认 Campaign 信息，状态推进: ${currentWorkflowState} → ${nextWorkflowState}`);
              } else {
                // 信息不完整，保持状态
                nextWorkflowState = WORKFLOW_STATES.STEP_2_CAMPAIGN_INFO;
              }
            } else {
              // 保持状态（等待用户确认或补充信息）
              nextWorkflowState = WORKFLOW_STATES.STEP_2_CAMPAIGN_INFO;
            }
          } else {
            // 其他情况，进入步骤 2
            nextWorkflowState = WORKFLOW_STATES.STEP_2_CAMPAIGN_INFO;
          }
          
          const newContext = {
            ...context,
            campaignInfo: campaignResult.campaignInfo,
            workflowState: nextWorkflowState,
          };

          console.log(`[AgentRouter] 工作流状态更新: ${currentWorkflowState} → ${nextWorkflowState} (${getWorkflowStateDescription(nextWorkflowState)})`);

          // 记录状态更新
          thinking.nextState = nextWorkflowState;
          const campaignStateStep = {
            agent: "AgentRouter",
            action: "状态更新",
            result: `${getWorkflowStateDescription(currentWorkflowState)} → ${getWorkflowStateDescription(nextWorkflowState)}`,
            reason: campaignResult.isConfirmed && hasAllFields ? "用户确认Campaign信息且信息完整" : "等待用户确认或补充信息",
            timestamp: new Date().toISOString(),
          };
          thinking.steps.push(campaignStateStep);
          sendThinkingUpdate({ 
            steps: [...thinking.steps], 
            nextState: thinking.nextState 
          });

          const nextToolCampaign = getAgentForState(nextWorkflowState);
          if (campaignResult.isConfirmed && hasAllFields && nextToolCampaign) {
            const chained = await this.runNextStageAgent(nextToolCampaign, messages, newContext, thinking, sendThinkingUpdate);
            if (chained) return chained;
          }
          return {
            reply: campaignResult.reply,
            context: newContext,
            thinking: thinking,
          };
        } else if (toolName === "influencer_profile_agent") {
          // 调用红人画像 Agent
          const influencerStep = {
            agent: "InfluencerProfileAgent",
            action: "推荐红人画像和账户",
            result: "基于产品信息和Campaign信息，生成红人画像要求并推荐符合要求的红人账户",
            timestamp: new Date().toISOString(),
          };
          thinking.steps.push(influencerStep);
          sendThinkingUpdate({ steps: [...thinking.steps] });
          
          // 初始化浏览器步骤和截图
          if (!thinking.browserSteps) {
            thinking.browserSteps = [];
          }
          if (!thinking.screenshots) {
            thinking.screenshots = [];
          }
          
          // 动态导入 updateSteps（避免顶层 await）
          let updateStepsFn = null;
          const getUpdateSteps = async () => {
            if (!updateStepsFn) {
              const module = await import('../utils/browser-steps.js');
              updateStepsFn = module.updateSteps;
            }
            return updateStepsFn;
          };
          
          // 创建步骤更新回调，用于展示5个函数的执行过程
          const influencerStepUpdate = async (stepUpdate) => {
            try {
              // 处理红人分析卡片（实时累积，用于右侧卡片区逐个展示）
              if (stepUpdate.type === 'influencerAnalysis' && stepUpdate.influencer) {
                thinking.influencerAnalyses = [...(thinking.influencerAnalyses || []), stepUpdate.influencer];
                if (process.env.NODE_ENV !== 'production') {
                  const who = stepUpdate.influencer?.id || stepUpdate.influencer?.name || 'unknown';
                  console.log(`[AgentRouter] ✅ 收到 influencerAnalysis: @${who}（累计 ${thinking.influencerAnalyses.length}）`);
                }
                sendThinkingUpdate({
                  steps: [...thinking.steps],
                  browserSteps: [...(thinking.browserSteps || [])],
                  screenshots: [],
                  influencerAnalyses: [...thinking.influencerAnalyses],
                });
                return;
              }
              // 处理结构化步骤
              if (stepUpdate.type === 'step' && stepUpdate.step) {
                const updateSteps = await getUpdateSteps();
                thinking.browserSteps = updateSteps(thinking.browserSteps, stepUpdate.step);
                sendThinkingUpdate({ 
                  steps: [...thinking.steps],
                  browserSteps: [...thinking.browserSteps],
                  screenshots: []
                });
              }
              // 处理截图：只保留最新 1 张，避免 SSE 单条消息过大导致前端解析失败或收不到第 2 个红人后的更新
              else if (stepUpdate.type === 'screenshot') {
                const newShot = {
                  stepId: stepUpdate.stepId,
                  label: stepUpdate.label,
                  image: stepUpdate.image,
                  timestamp: stepUpdate.timestamp
                };
                thinking.screenshots = [newShot];
                // 先单独发截图事件（小 payload），再发 thinking 不含图，避免单条 SSE 过大导致第 2 个红人起前端收不到
                sendThinkingUpdate({ type: 'screenshot', data: newShot });
                sendThinkingUpdate({
                  steps: [...thinking.steps],
                  browserSteps: [...thinking.browserSteps],
                  screenshots: []
                });
              }
              // 兼容旧的步骤格式
              else if (stepUpdate.step || stepUpdate.action) {
                const step = {
                  agent: stepUpdate.agent || "InfluencerProfileAgent",
                  action: stepUpdate.action || stepUpdate.step,
                  result: stepUpdate.result || stepUpdate.message,
                  timestamp: stepUpdate.timestamp || new Date().toISOString(),
                };
                thinking.steps.push(step);
                sendThinkingUpdate({ 
                  steps: [...thinking.steps],
                  browserSteps: [...thinking.browserSteps],
                  screenshots: []
                });
              }
            } catch (error) {
              // 捕获所有错误，避免未处理的 Promise rejection
              if (error.code === 'ERR_INVALID_STATE' || error.message?.includes('closed')) {
                console.warn('[AgentRouter] SSE 流已关闭，停止处理步骤更新');
              } else {
                console.error('[AgentRouter] 处理步骤更新失败:', error);
              }
            }
          };
          
          const influencerResult = await this.influencerProfileAgent.recommendInfluencers(messages, context, influencerStepUpdate);
          
          // 记录子Agent执行结果
          thinking.subAgentResult = {
            agent: "InfluencerProfileAgent",
            action: "推荐红人画像和账户",
            isConfirmed: influencerResult.isConfirmed,
            influencerCount: influencerResult.influencers?.length || 0,
            hasProfile: !!influencerResult.influencerProfile,
            summary: `推荐了 ${influencerResult.influencers?.length || 0} 个红人账户`,
          };
          sendThinkingUpdate({ subAgentResult: thinking.subAgentResult });
          
          // 更新上下文（含红人画像阶段标记，用于下一轮意图判断）
          const updatedContext = {
            ...context,
            influencerProfile: influencerResult.influencerProfile,
            influencers: influencerResult.influencers,
            influencerStep: influencerResult.meta?.influencerStep ?? context.influencerStep,
          };
          if (influencerResult.isConfirmed) {
            updatedContext.influencerStep = null;
          }
          
          // 使用子 agent 返回的 isConfirmed 判断是否推进状态
          const isConfirming = influencerResult.isConfirmed || false;
          
          // 更新工作流状态
          let nextWorkflowState = currentWorkflowState;
          if (currentWorkflowState === WORKFLOW_STATES.STEP_3_INFLUENCER_PROFILE) {
            // 如果已经在步骤 3
            if (isConfirming && influencerResult.influencerProfile) {
              // 用户确认红人画像，推进到步骤 4
              nextWorkflowState = WORKFLOW_STATES.STEP_4_CONTENT_REQUIREMENT;
              console.log(`[AgentRouter] 用户确认红人画像，状态推进: ${currentWorkflowState} → ${nextWorkflowState}`);
            } else {
              // 保持状态（等待用户确认或调整）
              nextWorkflowState = WORKFLOW_STATES.STEP_3_INFLUENCER_PROFILE;
            }
          } else {
            // 其他情况，进入步骤 3
            nextWorkflowState = WORKFLOW_STATES.STEP_3_INFLUENCER_PROFILE;
          }
          
          const newContext = {
            ...updatedContext,
            workflowState: nextWorkflowState,
          };

          console.log(`[AgentRouter] 工作流状态更新: ${currentWorkflowState} → ${nextWorkflowState} (${getWorkflowStateDescription(nextWorkflowState)})`);

          // 记录状态更新
          thinking.nextState = nextWorkflowState;
          const influencerStateStep = {
            agent: "AgentRouter",
            action: "状态更新",
            result: `${getWorkflowStateDescription(currentWorkflowState)} → ${getWorkflowStateDescription(nextWorkflowState)}`,
            reason: influencerResult.isConfirmed ? "用户确认红人画像" : "等待用户确认或调整",
            timestamp: new Date().toISOString(),
          };
          thinking.steps.push(influencerStateStep);
          sendThinkingUpdate({ 
            steps: [...thinking.steps], 
            nextState: thinking.nextState 
          });

          const nextToolInfluencer = getAgentForState(nextWorkflowState);
          if (influencerResult.isConfirmed && nextToolInfluencer) {
            const chained = await this.runNextStageAgent(nextToolInfluencer, messages, newContext, thinking, sendThinkingUpdate);
            if (chained) return chained;
          }
          return {
            reply: influencerResult.reply,
            context: newContext,
            thinking: thinking,
          };
        } else if (toolName === "content_requirement_agent") {
          // 调用内容要求 Agent（传递完整 context，包含 productInfo、campaignInfo、influencerProfile）
          const contentStep = {
            agent: "ContentRequirementAgent",
            action: "生成内容脚本",
            result: "基于产品信息、Campaign信息和红人画像，生成内容脚本要求和参考视频",
            timestamp: new Date().toISOString(),
          };
          thinking.steps.push(contentStep);
          sendThinkingUpdate({ steps: [...thinking.steps] });
          const contentResult = await this.contentRequirementAgent.generateContent(
            messages,
            context
          );
          
          // 记录子Agent执行结果
          thinking.subAgentResult = {
            agent: "ContentRequirementAgent",
            action: "生成内容脚本",
            isConfirmed: contentResult.isConfirmed,
            hasScript: !!contentResult.contentScript,
            hasVideo: !!contentResult.video?.videoUrl,
            summary: contentResult.contentScript ? "内容脚本已生成" : "内容脚本生成失败",
          };
          sendThinkingUpdate({ subAgentResult: thinking.subAgentResult });

          // 更新上下文
          const updatedContext = {
            ...context,
            contentScript: contentResult.contentScript,
            video: contentResult.video,
          };
          
          // 使用子 agent 返回的 isConfirmed 判断是否推进状态
          const isConfirming = contentResult.isConfirmed || false;
          
          // 更新工作流状态
          let nextWorkflowState = currentWorkflowState;
          if (currentWorkflowState === WORKFLOW_STATES.STEP_4_CONTENT_REQUIREMENT) {
            // 如果已经在步骤 4
            if (isConfirming && contentResult.contentScript) {
              // 用户确认内容要求，推进到步骤 5
              nextWorkflowState = WORKFLOW_STATES.STEP_5_PUBLISH_CONFIRM;
              console.log(`[AgentRouter] 用户确认内容要求，状态推进: ${currentWorkflowState} → ${nextWorkflowState}`);
            } else {
              // 保持状态（等待用户确认）
              nextWorkflowState = WORKFLOW_STATES.STEP_4_CONTENT_REQUIREMENT;
            }
          } else {
            // 其他情况，进入步骤 4
            nextWorkflowState = WORKFLOW_STATES.STEP_4_CONTENT_REQUIREMENT;
          }

          const newContext = {
            ...updatedContext,
            workflowState: nextWorkflowState,
          };

          console.log(`[AgentRouter] 工作流状态更新: ${currentWorkflowState} → ${nextWorkflowState} (${getWorkflowStateDescription(nextWorkflowState)})`);

          // 记录状态更新
          thinking.nextState = nextWorkflowState;
          const contentStateStep = {
            agent: "AgentRouter",
            action: "状态更新",
            result: `${getWorkflowStateDescription(currentWorkflowState)} → ${getWorkflowStateDescription(nextWorkflowState)}`,
            reason: contentResult.isConfirmed ? "用户确认内容要求" : "等待用户确认",
            timestamp: new Date().toISOString(),
          };
          thinking.steps.push(contentStateStep);
          sendThinkingUpdate({ 
            steps: [...thinking.steps], 
            nextState: thinking.nextState 
          });

          const nextToolContent = getAgentForState(nextWorkflowState);
          if (contentResult.isConfirmed && contentResult.contentScript && nextToolContent) {
            const chained = await this.runNextStageAgent(nextToolContent, messages, newContext, thinking, sendThinkingUpdate);
            if (chained) return chained;
          }
          return {
            reply: contentResult.reply,
            context: newContext,
            thinking: thinking,
          };
        } else if (toolName === "campaign_publish_agent") {
          // 调用 Campaign 发布 Agent
          const publishStep = {
            agent: "CampaignPublishAgent",
            action: "汇总并确认发布",
            result: "检查信息完整性，汇总所有Campaign信息，确认发布",
            timestamp: new Date().toISOString(),
          };
          thinking.steps.push(publishStep);
          sendThinkingUpdate({ steps: [...thinking.steps] });
          const publishResult = await this.campaignPublishAgent.confirmAndPublish(
            messages,
            context
          );
          
          // 记录子Agent执行结果
          thinking.subAgentResult = {
            agent: "CampaignPublishAgent",
            action: "汇总并确认发布",
            published: publishResult.published,
            campaignId: publishResult.campaignId,
            summary: publishResult.published ? `Campaign已发布，ID: ${publishResult.campaignId}` : "等待用户确认发布",
          };
          sendThinkingUpdate({ subAgentResult: thinking.subAgentResult });

          // 更新上下文和工作流状态
          let nextWorkflowState = currentWorkflowState;
          if (publishResult.published) {
            // 如果发布成功，进入空闲状态
            nextWorkflowState = WORKFLOW_STATES.IDLE;
          } else if (currentWorkflowState === WORKFLOW_STATES.STEP_5_PUBLISH_CONFIRM) {
            // 如果已经在步骤 5，保持状态（等待用户确认）
            nextWorkflowState = WORKFLOW_STATES.STEP_5_PUBLISH_CONFIRM;
          } else {
            // 其他情况，进入步骤 5
            nextWorkflowState = WORKFLOW_STATES.STEP_5_PUBLISH_CONFIRM;
          }

          const newContext = {
            ...context,
            published: publishResult.published,
            campaignId: publishResult.campaignId || context.campaignId,
            workflowState: nextWorkflowState,
          };

          console.log(`[AgentRouter] 工作流状态更新: ${currentWorkflowState} → ${nextWorkflowState} (${getWorkflowStateDescription(nextWorkflowState)})`);

          // 记录状态更新
          thinking.nextState = nextWorkflowState;
          const publishStateStep = {
            agent: "AgentRouter",
            action: "状态更新",
            result: `${getWorkflowStateDescription(currentWorkflowState)} → ${getWorkflowStateDescription(nextWorkflowState)}`,
            reason: publishResult.published ? "Campaign发布成功" : "等待用户确认发布",
            timestamp: new Date().toISOString(),
          };
          thinking.steps.push(publishStateStep);
          sendThinkingUpdate({ 
            steps: [...thinking.steps], 
            nextState: thinking.nextState 
          });

          const result = {
            reply: publishResult.reply,
            context: newContext,
            thinking: thinking,
          };

          // 如果发布成功且带有推荐标题，则异步更新对应会话的标题，方便左侧列表展示
          try {
            if (publishResult.published && publishResult.sessionTitle && context.sessionId) {
              // 这里不 await，避免阻塞主回复
              fetch(`/api/sessions/${context.sessionId}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ title: publishResult.sessionTitle, status: 'published' }),
              }).catch(() => {});
            }
          } catch (e) {
            // 静默失败，不影响主流程
          }

          return result;
        }
      }

      // 3. 不需要工具，检查是否需要更新工作流状态
      let updatedContext = { ...context };
      
      // 优先检查工作流状态更新（状态推进的优先级高于引导消息检测）
      if (binResult.workflowStateUpdate) {
        const { from, to, reason } = binResult.workflowStateUpdate;
        console.log(`[AgentRouter] 工作流状态自动推进: ${from} → ${to} (原因: ${reason})`);
        updatedContext.workflowState = to;
        
        // 记录状态更新
        thinking.nextState = to;
        const autoStateStep = {
          agent: "AgentRouter",
          action: "状态自动更新",
          result: `${getWorkflowStateDescription(from)} → ${getWorkflowStateDescription(to)}`,
          reason: reason,
          timestamp: new Date().toISOString(),
        };
        thinking.steps.push(autoStateStep);
        sendThinkingUpdate({ 
          steps: [...thinking.steps], 
          nextState: thinking.nextState 
        });
        
        // 如果状态需要更新，直接返回（不检查引导消息，因为状态推进更重要）
        return {
          reply: binResult.reply,
          context: updatedContext,
          thinking: thinking,
        };
      }
      
      // 如果返回了引导消息（toolCall 为 null 但有 reply），直接返回，不更新状态
      if (!binResult.toolCall && binResult.reply) {
        // 检查是否是引导消息（通常引导消息会包含"当前步骤"、"当前任务"等关键词）
        // 但要注意：如果 workflowStateUpdate 存在，说明是状态推进，不是引导消息
        const isGuideMessage = binResult.reply.includes("当前步骤") || 
                               binResult.reply.includes("当前任务") ||
                               binResult.reply.includes("一步一步来");
        
        if (isGuideMessage) {
          console.log(`[AgentRouter] 检测到引导消息，不更新工作流状态`);
          const guideStep = {
            agent: "AgentRouter",
            action: "引导消息",
            result: "检测到引导消息，保持当前状态",
            timestamp: new Date().toISOString(),
          };
          thinking.steps.push(guideStep);
          sendThinkingUpdate({ steps: [...thinking.steps] });
          return {
            reply: binResult.reply,
            context: context, // 保持原状态
            thinking: thinking,
          };
        }
      }
      
      // 确保 workflowState 存在
      if (!updatedContext.workflowState) {
        updatedContext.workflowState = WORKFLOW_STATES.IDLE;
      }
      
      // 记录直接回复
      const directReplyStep = {
        agent: "BinAgent",
        action: "直接回复",
        result: "无需调用工具，直接回复用户",
        timestamp: new Date().toISOString(),
      };
      thinking.steps.push(directReplyStep);
      sendThinkingUpdate({ steps: [...thinking.steps] });
      
      return {
        reply: binResult.reply,
        context: updatedContext,
        thinking: thinking,
      };
    } catch (error) {
      console.error("[AgentRouter] 处理失败:", error);
      throw error;
    }
  }
}