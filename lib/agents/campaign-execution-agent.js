/**
 * Campaign Execution Agent：发布后的执行阶段
 * 负责：定时汇报配置、执行速度、修改 campaign、与红人特殊情况沟通（委托红人经纪人 agent）
 */
import { BaseAgent } from "./base-agent.js";
import { callDeepSeekLLM } from "../utils/llm-client.js";
import { CAMPAIGN_EXECUTION_TOOL_SCHEMAS } from "../tools/campaign-execution/campaign-execution-tools.js";

const TOOL_NAMES = CAMPAIGN_EXECUTION_TOOL_SCHEMAS.map((t) => t.name);

export class CampaignExecutionAgent extends BaseAgent {
  constructor() {
    const systemPrompt = `你是 Bin 的 Campaign 执行助手。当前对话对应的 Campaign 已发布，你负责帮助广告主：
1. 设置定时汇报（汇报间隔、时间点、内容偏好）
2. 调整执行速度（每天联系多少位红人）
3. 修改 campaign 内容（筛选条件、发布时间等，可整体或单个红人），修改后会由红人经纪人同步给红人
4. 向某位红人发起特殊请求（如延后发布时间），并回收红人反馈后同步给广告主
5. 查询 campaign 执行状态
6. 红人执行阶段操作：
   - 同意/通过某红人报价 → approve_quote
   - 暂不通过/拒绝某红人报价 → reject_quote
   - 确认已寄样给某红人 → confirm_ship
   - 通过某红人视频草稿 → approve_draft
   - 不通过某红人草稿并给修改建议 → reject_draft（feedback 必填）
   - 更新某红人已发布视频数据（链接、投流码、播放量等）→ update_published

【汇报形式可选项】
- brief（简要汇总）：只给关键数字和简单结论。
- detailed（详细报告）：包含各阶段、各红人的详细说明。
- summary_only（仅汇总数字）：只给总量，不列出名单。

【重点指标常见选项】
- pending_price_count：待审核价格的红人数。
- pending_sample_count：待寄送样品的红人数。
- pending_draft_count：待审核草稿的红人数。
- published_count：已发布视频的红人数。
（也可以根据需要扩展更多指标，但应该向用户说明这些名称的含义。）

红人 ID 可从用户名、@handle、昵称推断，如 alice_fashion、bob_lifestyle、emma_fit 等。

重要约定：
- 当用户说「每天联系 20 位」「每天只联系 3 个」等，必须调用 set_execution_pacing，并在 params.influencersPerDay 中填入该数字，避免只设置 pacingMode。
- 当用户说「每 2 天汇报一次」「每周一汇报一次」「每天上午 9 点汇报」等，必须调用 set_report_schedule，并在 params.intervalHours/params.interval 或 params.reportTime 中反映这些信息。
- 当用户要求「以后日报里多加 XXX 指标」时，应该先读取现有 includeMetrics，再在数组中追加新指标整体写回。
- 当用户询问「汇报形式和重点指标有哪些」「有哪些汇报方式可以选」这类问题时，这是在问说明书，不需要调用任何工具（needTool=false）。你应该直接用自然语言解释上面的选项，并举 1-2 个例子帮助理解。

当不需要调用工具时，你必须直接输出中文自然语言回复（不要输出 JSON）。`;

    super("CampaignExecutionAgent", systemPrompt);
  }

  /**
   * 意图识别 + 工具决策
   * @param {Array} messages - 消息历史
   * @param {Object} context - 上下文（必含 campaignId, published）
   * @returns {Promise<Object>} - { reply: string, toolCall: { toolName, params } | null }
   */
  async processWithTools(messages, context = {}) {
    const campaignId = context.campaignId;
    const lastMessage = messages[messages.length - 1]?.content || "";

    if (!campaignId) {
      return {
        reply: "当前会话暂无已发布的 Campaign，无法执行操作。请先完成 Campaign 发布。",
        toolCall: null,
      };
    }

    const toolsDesc = CAMPAIGN_EXECUTION_TOOL_SCHEMAS.map(
      (t) => `- ${t.name}: ${t.description}`
    ).join("\n");

    const prompt = `当前 Campaign ID: ${campaignId}

最近对话（最近 3 条）：
${messages.slice(-3).map((m) => `${m.role}: ${m.content}`).join("\n")}

可用工具：
${toolsDesc}

请根据用户最后一条消息判断是否需要调用工具。若需要，返回 JSON：
{ "needTool": true, "toolName": "工具名", "params": { ... } }
若不需要（寒暄、无法识别等），返回：
{ "needTool": false, "toolName": null, "params": null }

工具名必须是以下之一：${TOOL_NAMES.join(", ")}
params 需符合各工具的 parameters 定义，campaignId 可省略（将使用当前 ${campaignId}）。

只返回 JSON，不要其他文字。`;

    try {
      const raw = await callDeepSeekLLM(
        [{ role: "user", content: prompt }],
        "你是指令执行专家，只输出 JSON。"
      );
      const jsonMatch = raw.match(/\{[\s\S]*\}/);
      const decision = jsonMatch ? JSON.parse(jsonMatch[0]) : { needTool: false, toolName: null, params: null };

      if (decision.needTool && decision.toolName && TOOL_NAMES.includes(decision.toolName)) {
        const params = { ...(decision.params || {}), campaignId: decision.params?.campaignId || campaignId };
        let reply = "正在处理你的请求…";
        if (decision.toolName === "set_report_schedule") reply = "正在设置汇报偏好…";
        else if (decision.toolName === "set_execution_pacing") reply = "正在调整执行速度…";
        else if (decision.toolName === "modify_campaign") reply = "正在修改 campaign 并通知红人经纪人…";
        else if (decision.toolName === "ask_influencer_special_request") reply = "正在向红人发起请求…";
        else if (decision.toolName === "get_influencer_special_request_feedback") reply = "正在查询红人反馈…";
        else if (decision.toolName === "get_campaign_execution_status") reply = "正在获取执行状态…";
        else if (decision.toolName === "approve_quote") reply = "正在同意报价…";
        else if (decision.toolName === "reject_quote") reply = "正在暂不通过…";
        else if (decision.toolName === "confirm_ship") reply = "正在确认寄样…";
        else if (decision.toolName === "approve_draft") reply = "正在通过草稿…";
        else if (decision.toolName === "reject_draft") reply = "正在记录修改建议…";
        else if (decision.toolName === "update_published") reply = "正在更新发布数据…";
        return {
          reply,
          toolCall: { toolName: decision.toolName, params },
        };
      }

      const directReply = await this.process(messages, { ...context, campaignId });
      return { reply: directReply, toolCall: null };
    } catch (err) {
      console.error("[CampaignExecutionAgent] processWithTools 失败:", err);
      return {
        reply: "处理时出了点问题，请重试或换一种说法。",
        toolCall: null,
      };
    }
  }

  /**
   * 根据工具执行结果生成面向用户的回复（可选，用于润色）
   * @param {string} toolName
   * @param {Object} toolResult - { success, data, message }
   * @param {Array} messages
   * @param {Object} context
   * @returns {Promise<string>}
   */
  async replyFromToolResult(toolName, toolResult, messages, context) {
    if (toolResult.message) return toolResult.message;
    if (toolResult.success && toolResult.data) {
      return `操作完成。${JSON.stringify(toolResult.data, null, 2)}`;
    }
    return toolResult.message || "操作已完成。";
  }
}
