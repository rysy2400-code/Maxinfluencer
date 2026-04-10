// 子 Agent 5: Campaign 发布确认 Agent
import { BaseAgent } from "./base-agent.js";
import { callDeepSeekLLM } from "../utils/llm-client.js";
import { createCampaign } from "../db/campaign-dao.js";
import { upsertReportConfig } from "../db/campaign-report-config-dao.js";

export class CampaignPublishAgent extends BaseAgent {
  constructor() {
    const systemPrompt = `你是 Campaign 发布确认专家。你的任务是汇总所有已收集的 Campaign 信息，与客户最终确认，并执行发布操作。

工作流程：
1. 检查所有必要信息是否完整（产品信息、Campaign 信息、红人画像、内容脚本）
2. 如果有缺失信息，提示用户补充
3. 如果信息完整，生成格式化的汇总报告
4. 与客户确认所有信息
5. 客户确认后，执行发布操作
6. 返回发布结果和 Campaign ID

回复要专业、清晰，用中文与客户沟通。`;

    super("CampaignPublishAgent", systemPrompt);
  }

  /**
   * 汇总并确认 Campaign 发布
   * @param {Array} messages - 消息历史
   * @param {Object} context - 上下文（包含所有已收集的信息）
   * @returns {Promise<Object>} - { reply: string, published: boolean, campaignId?: string }
   */
  async confirmAndPublish(messages, context = {}) {
    try {
      const productInfo = context.productInfo || {};
      const campaignInfo = context.campaignInfo || {};
      const influencerProfile = context.influencerProfile || null;
      const influencers = context.influencers || [];
      const contentScript = context.contentScript || null;
      const lastMessage = messages[messages.length - 1]?.content || "";

      // 1. 检查信息完整性
      const completenessCheck = this.checkCompleteness({
        productInfo,
        campaignInfo,
        influencerProfile,
        influencers,
        contentScript,
      });

      if (!completenessCheck.isComplete) {
        return {
          reply: completenessCheck.message,
          published: false,
        };
      }

      // 2. 检测用户是否确认发布
      const isConfirming = await this.detectConfirmation(messages, context);
      const isPublished = context.published || false;
      const campaignId = context.campaignId || null;

      // 如果已经发布，直接返回已发布信息
      if (isPublished && campaignId) {
        return {
          reply: `Campaign 已成功发布！\n\n**Campaign ID**: ${campaignId}\n\n你可以使用此 ID 来查询和管理 Campaign。`,
          published: true,
          campaignId,
        };
      }

      // 3. 如果用户确认发布，执行发布操作
      if (isConfirming) {
        const publishResult = await this.publishCampaign(
          {
            productInfo,
            campaignInfo,
            influencerProfile,
            influencers,
            contentScript,
          },
          context.sessionId
        );

        if (publishResult.success) {
          const { influencersPerDay, reportTime, sessionTitle } = publishResult;
          return {
            reply: `Campaign 已发布。\n\n当前设置：每天联系 **${influencersPerDay}** 位符合要求的红人，**每日 ${reportTime}** 汇报进展。\n\n如需调整，可以说「每天联系 20 位」或「每 2 天汇报一次」。`,
            published: true,
            campaignId: publishResult.campaignId,
            sessionTitle: sessionTitle || null,
          };
        } else {
          return {
            reply: `抱歉，Campaign 发布失败：${publishResult.error}。\n\n请稍后重试，或联系技术支持。`,
            published: false,
          };
        }
      }

      // 4. 如果用户未确认，生成汇总报告并等待确认
      const summary = this.formatSummary({
        productInfo,
        campaignInfo,
        influencerProfile,
        influencers,
        contentScript,
      });

      return {
        reply: `我已经为你汇总了完整的 Campaign 信息，请确认：\n\n${summary}\n\n如果没问题，请回复「确认发布」或「发布」，我将完成发布并进入 Campaign 执行阶段。如需修改，请告诉我需要调整的部分。`,
        published: false,
      };
    } catch (error) {
      console.error("[CampaignPublishAgent] 发布确认失败:", error);
      return {
        reply: `抱歉，处理 Campaign 发布时出现错误：${error.message}。\n\n请稍后再试，或联系技术支持。`,
        published: false,
      };
    }
  }

  /**
   * 检查信息完整性
   * @param {Object} data - 所有收集的信息
   * @returns {Object} - { isComplete: boolean, message?: string }
   */
  checkCompleteness(data) {
    const { productInfo, campaignInfo, influencerProfile, influencers, contentScript } = data;
    const missing = [];

    // 检查产品信息
    if (!productInfo || !productInfo.productName) {
      missing.push("产品信息");
    }

    // 检查 Campaign 信息
    if (!campaignInfo) {
      missing.push("Campaign 信息");
    } else {
      if (!campaignInfo.platform) missing.push("投放平台");
      if (!campaignInfo.region) missing.push("投放地区");
      if (!campaignInfo.publishTimeRange) missing.push("发布时间段");
      if (campaignInfo.budget === null || campaignInfo.budget === undefined) missing.push("预算");
      if (campaignInfo.commission === null || campaignInfo.commission === undefined) missing.push("佣金");
    }

    // 检查红人画像
    if (!influencerProfile) {
      missing.push("红人画像要求");
    }

    // 红人账户列表为可选（用户可选择「直接下一步」不找红人名单）

    // 检查内容脚本
    if (!contentScript || !contentScript.script) {
      missing.push("内容脚本");
    }

    if (missing.length > 0) {
      return {
        isComplete: false,
        message: `抱歉，以下信息尚未完成：${missing.join("、")}。\n\n请先完成这些步骤，然后再进行发布确认。`,
      };
    }

    return { isComplete: true };
  }

  /**
   * 检测用户是否确认发布
   * @param {Array} messages - 消息历史
   * @param {Object} context - 上下文（包含所有信息）
   * @returns {Promise<boolean>} - 是否确认
   */
  async detectConfirmation(messages, context = {}) {
    const lastMessage = messages[messages.length - 1]?.content || "";
    const conversationHistory = messages.slice(-3).map(m => `${m.role}: ${m.content}`).join("\n");

    const prompt = `判断用户是否确认发布 Campaign。

对话历史：
${conversationHistory}

如果用户确认发布（如"确认发布"、"发布"、"确认"、"发布campaign"、"确认发布campaign"、"好的，发布"、"可以发布"、"发布吧"、"提交"、"确认提交"等），返回 true。
如果用户要求修改或取消，返回 false。
如果消息不明确或只是询问，返回 false。

只返回 JSON 格式：
{
  "confirmed": true | false
}`;

    try {
      const llmResponse = await callDeepSeekLLM(
        [{ role: "user", content: prompt }],
        "你是一个意图识别专家，擅长判断用户是否确认发布。只返回 JSON 格式，不要其他文字。"
      );

      try {
        const result = JSON.parse(llmResponse);
        return result.confirmed === true;
      } catch (e) {
        const jsonMatch = llmResponse.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          const result = JSON.parse(jsonMatch[0]);
          return result.confirmed === true;
        }
        return false;
      }
    } catch (error) {
      console.warn("[CampaignPublishAgent] 判断确认失败:", error);
      return false;
    }
  }

  /**
   * 格式化汇总报告
   * @param {Object} data - 所有收集的信息
   * @returns {string} - 格式化后的汇总文本
   */
  formatSummary(data) {
    const { productInfo, campaignInfo, influencerProfile, influencers, contentScript } = data;
    const parts = [];

    // 产品信息
    parts.push("📦 **产品信息**");
    if (productInfo.brandName) parts.push(`- 品牌：${productInfo.brandName}`);
    if (productInfo.productName) parts.push(`- 产品：${productInfo.productName}`);
    if (productInfo.productType) parts.push(`- 类型：${productInfo.productType}`);
    if (productInfo.description) parts.push(`- 描述：${productInfo.description}`);
    parts.push("");

    // Campaign 信息
    parts.push("📊 **Campaign 信息**");
    if (campaignInfo.platform) {
      const platforms = Array.isArray(campaignInfo.platform)
        ? campaignInfo.platform.map((p) => (p === "Ins" ? "Instagram" : p)).join("、")
        : campaignInfo.platform === "Ins" ? "Instagram" : campaignInfo.platform;
      parts.push(`- 投放平台：${platforms}`);
    }
    if (campaignInfo.region) {
      const regions = Array.isArray(campaignInfo.region)
        ? campaignInfo.region.join("、")
        : campaignInfo.region;
      parts.push(`- 投放地区：${regions}`);
    }
    if (campaignInfo.publishTimeRange) {
      parts.push(`- 发布时间段：${campaignInfo.publishTimeRange}`);
    }
    if (campaignInfo.budget !== null && campaignInfo.budget !== undefined) {
      parts.push(`- 预算：$${campaignInfo.budget.toLocaleString()} USD`);
    }
    if (campaignInfo.commission !== null && campaignInfo.commission !== undefined) {
      parts.push(`- 佣金：${campaignInfo.commission}%`);
    }
    parts.push("");

    // 红人画像要求
    if (influencerProfile) {
      parts.push("👥 **红人画像要求**");
      if (influencerProfile.followerRange) {
        parts.push(`- 粉丝量：${influencerProfile.followerRange}`);
      }
      if (influencerProfile.viewRange) {
        parts.push(`- 播放量：${influencerProfile.viewRange}`);
      }
      if (influencerProfile.accountType) {
        parts.push(`- 账户类型：${influencerProfile.accountType}`);
      }
      parts.push("");
    }

    // 推荐红人账户
    if (influencers && influencers.length > 0) {
      parts.push(`👤 **推荐红人账户（${influencers.length}个）**`);
      influencers.forEach((inf, index) => {
        parts.push(`${index + 1}. ${inf.name || inf.id} - ${inf.followers || "未知粉丝量"}`);
      });
      parts.push("");
    }

    // 内容脚本要求
    if (contentScript) {
      parts.push("📝 **内容脚本要求**");
      if (contentScript.title) {
        parts.push(`- 标题：${contentScript.title}`);
      }
      if (contentScript.duration) {
        parts.push(`- 时长建议：${contentScript.duration}`);
      }
      if (contentScript.platform) {
        parts.push(`- 平台：${contentScript.platform}`);
      }
      if (contentScript.keyPoints && contentScript.keyPoints.length > 0) {
        parts.push(`- 关键要点：`);
        contentScript.keyPoints.forEach((point, index) => {
          parts.push(`  ${index + 1}. ${point}`);
        });
      }
      if (contentScript.script) {
        parts.push(`- 脚本内容：\n${contentScript.script}`);
      }
      parts.push("");
    }

    return parts.join("\n");
  }

  /**
   * 执行发布操作：写入 campaigns 表，并返回「品牌名 + 产品名」用于命名会话
   * @param {Object} data - 所有收集的信息
   * @param {string} [sessionId] - 关联的 campaign_sessions.id（可选）
   * @returns {Promise<Object>} - { success: boolean, campaignId?: string, error?: string }
   */
  async publishCampaign(data, sessionId = "") {
    try {
      console.log("[CampaignPublishAgent] 开始发布 Campaign...");

      const campaignId = `CAMP-${Date.now()}-${Math.random().toString(36).substr(2, 9).toUpperCase()}`;

      const influencersPerDay = 100;
      const reportTime = "10:00";

      await createCampaign({
        id: campaignId,
        sessionId: sessionId || campaignId,
        productInfo: data.productInfo,
        campaignInfo: data.campaignInfo,
        influencerProfile: data.influencerProfile,
        influencers: data.influencers,
        contentScript: data.contentScript,
        influencersPerDay,
      });

      try {
        const needSample =
          data.productInfo && typeof data.productInfo.needSample === "boolean"
            ? data.productInfo.needSample
            : true;
        const defaultMetrics = needSample
          ? ["pending_price_count", "pending_sample_count", "pending_draft_count", "published_count"]
          : ["pending_price_count", "pending_draft_count", "published_count"];

        await upsertReportConfig({
          campaignId,
          intervalHours: 24,
          reportTime,
          contentPreference: "brief",
          includeMetrics: defaultMetrics,
        });
      } catch (e) {
        console.warn("[CampaignPublishAgent] 汇报配置写入失败（可忽略）:", e?.message);
      }

      // 生成推荐的 Session 标题：品牌名 + 产品名（或类型）
      const brand = data.productInfo?.brandName || "";
      const product =
        data.productInfo?.productName ||
        data.productInfo?.productType ||
        "";
      const sessionTitle = [brand, product].filter(Boolean).join(" ").trim() || `Campaign ${campaignId}`;

      console.log(`[CampaignPublishAgent] Campaign 发布成功，ID: ${campaignId}, title: ${sessionTitle}`);
      return {
        success: true,
        campaignId,
        influencersPerDay,
        reportTime,
        sessionTitle,
      };
    } catch (error) {
      console.error("[CampaignPublishAgent] 发布失败:", error);
      return {
        success: false,
        error: error.message || "发布操作失败",
      };
    }
  }
}

