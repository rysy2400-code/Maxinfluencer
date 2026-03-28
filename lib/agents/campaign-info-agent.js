// 子 Agent 2: 确认 Campaign 信息 Agent
import { BaseAgent } from "./base-agent.js";
import { callDeepSeekLLM } from "../utils/llm-client.js";

export class CampaignInfoAgent extends BaseAgent {
  constructor() {
    const systemPrompt = `你是 Campaign 信息确认专家。你的任务是与客户确认 campaign 的基本信息。

Campaign 基本信息包括：
1. 投放平台（必填）：TikTok 或 Instagram（Ins），只能选择其中一个或多个
2. 投放地区（必填）：美国或德国，只能选择其中一个或多个
3. 发布时间段（必填）：campaign 的发布时间范围，例如 "2024年3月1日-3月31日"
4. 预算（必填）：总预算金额，单位：美元（USD）
5. 佣金（必填）：给红人的佣金比例，单位：百分比（%）

工作流程：
1. 主动询问客户以上信息（如果缺少任何一项）
2. 从客户的消息中提取已提供的信息
3. 验证信息的有效性：
   - 平台必须是 "TikTok" 或 "Instagram"（或 "Ins"）
   - 地区必须是 "美国" 或 "德国"
   - 预算必须是正数
   - 佣金必须是 0-100 之间的数字
4. 整理已收集的信息，与客户确认
5. 如果信息不完整，继续询问缺失的信息
6. 如果信息完整且客户确认，告知可以进入下一步

回复要专业、清晰，用中文与客户沟通。`;

    super("CampaignInfoAgent", systemPrompt);
  }

  /**
   * 收集并确认 Campaign 信息
   * @param {Array} messages - 消息历史
   * @param {Object} context - 上下文（可能包含已有的 campaignInfo）
   * @returns {Promise<Object>} - { reply: string, campaignInfo: Object, isConfirmed: boolean }
   */
  async collectCampaignInfo(messages, context = {}) {
    try {
      // 获取已有的 campaign 信息（如果有）
      const existingCampaignInfo = context.campaignInfo || {};
      
      // 使用 LLM 从最新消息中提取信息
      const lastMessage = messages[messages.length - 1]?.content || "";
      const conversationHistory = messages.slice(-5).map(m => `${m.role}: ${m.content}`).join("\n");
      
      const extractionPrompt = `你是信息提取专家。从以下对话中提取 Campaign 信息。

对话历史：
${conversationHistory}

已有信息：
${Object.keys(existingCampaignInfo).length > 0 ? JSON.stringify(existingCampaignInfo, null, 2) : "无"}

需要提取的信息：
1. platform（平台）：必须是 "TikTok" 或 "Instagram" 中的一个或多个，用数组表示，例如 ["TikTok"] 或 ["TikTok", "Instagram"]
2. region（地区）：必须是 "美国" 或 "德国" 中的一个或多个，用数组表示，例如 ["美国"] 或 ["美国", "德国"]
3. publishTimeRange（发布时间段）：字符串，例如 "2024年3月1日-3月31日"
4. budget（预算）：数字，单位：美元
5. commission（佣金）：数字，单位：百分比（0-100）

如果用户消息中没有提到某项信息，该项为 null。
如果用户提到多个平台或地区，提取所有提到的。

只返回 JSON 格式，不要其他文字：
{
  "platform": ["TikTok"] | ["Instagram"] | ["TikTok", "Instagram"] | null,
  "region": ["美国"] | ["德国"] | ["美国", "德国"] | null,
  "publishTimeRange": "2024年3月1日-3月31日" | null,
  "budget": 10000 | null,
  "commission": 15 | null
}`;

      let extractedInfo;
      try {
        const llmResponse = await callDeepSeekLLM(
          [{ role: "user", content: extractionPrompt }],
          "你是一个信息提取专家，擅长从对话中提取结构化信息。只返回 JSON 格式，不要其他文字。"
        );

        console.log(`[CampaignInfoAgent] LLM 提取返回: ${llmResponse.substring(0, 200)}`);

        try {
          extractedInfo = JSON.parse(llmResponse);
        } catch (e) {
          const jsonMatch = llmResponse.match(/\{[\s\S]*\}/);
          if (jsonMatch) {
            extractedInfo = JSON.parse(jsonMatch[0]);
          } else {
            throw new Error("无法解析 LLM 返回的 JSON");
          }
        }
      } catch (extractError) {
        console.warn(`[CampaignInfoAgent] LLM 提取失败，使用已有信息:`, extractError);
        extractedInfo = {};
      }

      // 合并已有信息和提取的信息
      const mergedInfo = {
        platform: extractedInfo.platform || existingCampaignInfo.platform || null,
        region: extractedInfo.region || existingCampaignInfo.region || null,
        publishTimeRange: extractedInfo.publishTimeRange || existingCampaignInfo.publishTimeRange || null,
        budget: extractedInfo.budget !== null && extractedInfo.budget !== undefined 
          ? extractedInfo.budget 
          : (existingCampaignInfo.budget !== null && existingCampaignInfo.budget !== undefined 
              ? existingCampaignInfo.budget 
              : null),
        commission: extractedInfo.commission !== null && extractedInfo.commission !== undefined 
          ? extractedInfo.commission 
          : (existingCampaignInfo.commission !== null && existingCampaignInfo.commission !== undefined 
              ? existingCampaignInfo.commission 
              : null),
      };

      // 计算合并前缺失字段，用于判断「本次调用是否刚好补齐全部信息」
      const missingFieldsBefore = this.getMissingFields(
        existingCampaignInfo || {}
      );

      // 验证信息有效性
      const validationResult = this.validateCampaignInfo(mergedInfo);
      
      if (!validationResult.isValid) {
        // 信息无效，返回友好的引导消息
        // 同时过滤掉无效的平台和地区，只保留有效的
        const filteredInfo = { ...mergedInfo };
        
        if (validationResult.invalidPlatforms && validationResult.invalidPlatforms.length > 0) {
          // 过滤掉无效的平台，只保留有效的
          const validPlatforms = ["TikTok", "Instagram", "Ins"];
          if (Array.isArray(filteredInfo.platform)) {
            filteredInfo.platform = filteredInfo.platform.filter(p => {
              const normalized = p === "Ins" ? "Instagram" : p;
              return validPlatforms.includes(normalized) || validPlatforms.includes(p);
            });
            if (filteredInfo.platform.length === 0) {
              filteredInfo.platform = null;
            }
          } else {
            const normalized = filteredInfo.platform === "Ins" ? "Instagram" : filteredInfo.platform;
            if (!validPlatforms.includes(normalized) && !validPlatforms.includes(filteredInfo.platform)) {
              filteredInfo.platform = null;
            }
          }
        }
        
        if (validationResult.invalidRegions && validationResult.invalidRegions.length > 0) {
          // 过滤掉无效的地区，只保留有效的
          const validRegions = ["美国", "德国"];
          if (Array.isArray(filteredInfo.region)) {
            filteredInfo.region = filteredInfo.region.filter(r => validRegions.includes(r));
            if (filteredInfo.region.length === 0) {
              filteredInfo.region = null;
            }
          } else {
            if (!validRegions.includes(filteredInfo.region)) {
              filteredInfo.region = null;
            }
          }
        }
        
        return {
          reply: validationResult.errorMessage,
          campaignInfo: filteredInfo, // 保留有效信息，过滤掉无效的
          isConfirmed: false,
        };
      }

      // 检查信息是否完整
      const missingFields = this.getMissingFields(mergedInfo);
      const justCompleted =
        missingFieldsBefore.length > 0 && missingFields.length === 0;
      
      if (missingFields.length > 0) {
        // 信息不完整，让 LLM 生成补充话术（语气与其他子 Agent 保持一致：专业、清晰、偏商务）
        let reply;
        try {
          reply = await this.generateMissingInfoReply(mergedInfo, missingFields);
        } catch (e) {
          console.warn(
            "[CampaignInfoAgent] 生成缺失字段话术失败，使用兜底模板:",
            e
          );

          const fieldPrompts = {
            platform: "投放平台：",
            region: "投放地区：",
            publishTimeRange: "发布时间段：",
            budget: "预算：",
            commission: "佣金：",
          };

          const missingFieldsLines = missingFields
            .map((field) => fieldPrompts[field] || "")
            .filter((line) => line)
            .join("\n");

          reply = `产品信息已经确认，还需要你补充以下 Campaign 信息：\n\n${missingFieldsLines}\n\n请补充以上信息，我们即可进入下一步。`;
        }

        return {
          reply,
          campaignInfo: mergedInfo,
          isConfirmed: false,
        };
      }

      // 信息完整，与客户确认
      const confirmationMessage = `我已经收集到以下 Campaign 信息，请确认是否正确：\n\n${this.formatCampaignInfo(mergedInfo)}\n\n如需调整请告诉我；确认无误后我们进入下一阶段。`;
      
      // 如果是本轮刚补齐所有字段，先只展示确认信息，不自动判定为已确认
      let isConfirmed = false;
      if (!justCompleted) {
        // 只有在之前就已是完整信息时，才根据本轮用户回复判断是否确认
        isConfirmed = await this.detectConfirmation(messages, {
          campaignInfo: mergedInfo,
        });
      }

      return {
        reply: confirmationMessage,
        campaignInfo: mergedInfo,
        isConfirmed,
      };
    } catch (error) {
      console.error("[CampaignInfoAgent] 收集 Campaign 信息失败:", error);
      
      return {
        reply: `抱歉，处理 Campaign 信息时遇到问题：${error.message}。\n\n请重新提供信息，或者告诉我具体需要帮助的地方。`,
        campaignInfo: context.campaignInfo || {},
        isConfirmed: false,
      };
    }
  }

  /**
   * 检测用户是否确认 Campaign 信息
   * @param {Array} messages - 消息历史
   * @param {Object} context - 上下文（包含 campaignInfo）
   * @returns {Promise<boolean>} - 是否确认
   */
  async detectConfirmation(messages, context = {}) {
    const lastMessage = messages[messages.length - 1]?.content || "";
    const campaignInfo = context.campaignInfo;
    const conversationHistory = messages.slice(-3).map(m => `${m.role}: ${m.content}`).join("\n");

    // 如果没有 Campaign 信息，不需要判断确认
    if (!campaignInfo) {
      return false;
    }

    // 检查信息是否完整
    const missingFields = this.getMissingFields(campaignInfo);
    if (missingFields.length > 0) {
      // 信息不完整，不能确认
      return false;
    }

    const prompt = `判断用户是否确认了 Campaign 信息。

对话历史：
${conversationHistory}

Campaign 信息：
${this.formatCampaignInfo(campaignInfo)}

如果用户确认 Campaign 信息（如"确认"、"正确"、"无误"、"可以"、"好的"、"行"、"没问题"、"继续"、"下一步"等），返回 true。
如果用户要求修改或指出错误，返回 false。
如果消息不明确或只是询问，返回 false。

只返回 JSON 格式：
{
  "confirmed": true | false
}`;

    try {
      const llmResponse = await callDeepSeekLLM(
        [{ role: "user", content: prompt }],
        "你是一个意图识别专家，擅长判断用户是否确认信息。只返回 JSON 格式，不要其他文字。"
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
      console.warn("[CampaignInfoAgent] 判断确认失败:", error);
      return false;
    }
  }

  /**
   * 验证 Campaign 信息的有效性
   * @param {Object} info - Campaign 信息
   * @returns {Object} - { isValid: boolean, errorMessage?: string }
   */
  validateCampaignInfo(info) {
    const validPlatforms = ["TikTok", "Instagram", "Ins"];
    const validRegions = ["美国", "德国"];
    const invalidPlatforms = [];
    const invalidRegions = [];
    
    // 验证平台
    if (info.platform) {
      const platforms = Array.isArray(info.platform) ? info.platform : [info.platform];
      
      for (const platform of platforms) {
        // 标准化平台名称（Ins -> Instagram）
        const normalizedPlatform = platform === "Ins" ? "Instagram" : platform;
        if (!validPlatforms.includes(normalizedPlatform) && !validPlatforms.includes(platform)) {
          invalidPlatforms.push(platform);
        }
      }
    }

    // 验证地区
    if (info.region) {
      const regions = Array.isArray(info.region) ? info.region : [info.region];
      
      for (const region of regions) {
        if (!validRegions.includes(region)) {
          invalidRegions.push(region);
        }
      }
    }

    // 如果有不支持的平台或地区，生成友好的引导消息
    if (invalidPlatforms.length > 0 || invalidRegions.length > 0) {
      const errorMessages = [];
      
      if (invalidPlatforms.length > 0) {
        const invalidPlatformsText = invalidPlatforms.join("、");
        errorMessages.push(`目前仅支持 TikTok 和 Instagram，${invalidPlatformsText}会尽快开放，咱们是否考虑在TikTok 和 Instagram投放呀？`);
      }
      
      if (invalidRegions.length > 0) {
        const invalidRegionsText = invalidRegions.join("、");
        errorMessages.push(`目前仅支持美国和德国，${invalidRegionsText}会尽快开放，咱们是否考虑在美国和德国投放呀？`);
      }
      
      return {
        isValid: false,
        errorMessage: errorMessages.join("\n\n"),
        invalidPlatforms: invalidPlatforms, // 记录无效的平台，供外部使用
        invalidRegions: invalidRegions, // 记录无效的地区，供外部使用
      };
    }

    // 验证预算
    if (info.budget !== null && info.budget !== undefined) {
      const budget = Number(info.budget);
      if (isNaN(budget) || budget <= 0) {
        return {
          isValid: false,
          errorMessage: `预算 "${info.budget}" 无效。预算必须是大于 0 的数字。`,
        };
      }
    }

    // 验证佣金
    if (info.commission !== null && info.commission !== undefined) {
      const commission = Number(info.commission);
      if (isNaN(commission) || commission < 0 || commission > 100) {
        return {
          isValid: false,
          errorMessage: `佣金 "${info.commission}" 无效。佣金必须是 0-100 之间的数字（百分比）。`,
        };
      }
    }

    return { isValid: true };
  }

  /**
   * 获取缺失的字段
   * @param {Object} info - Campaign 信息
   * @returns {Array<string>} - 缺失的字段名数组
   */
  getMissingFields(info) {
    const requiredFields = ["platform", "region", "publishTimeRange", "budget", "commission"];
    const missing = [];
    
    for (const field of requiredFields) {
      if (info[field] === null || info[field] === undefined || 
          (Array.isArray(info[field]) && info[field].length === 0)) {
        missing.push(field);
      }
    }
    
    return missing;
  }

  /**
   * 格式化 Campaign 信息为可读文本
   * @param {Object} info - Campaign 信息
   * @returns {string} - 格式化后的文本
   */
  formatCampaignInfo(info) {
    const parts = [];
    
    if (info.platform) {
      const platforms = Array.isArray(info.platform) ? info.platform : [info.platform];
      // 标准化平台名称
      const normalizedPlatforms = platforms.map(p => p === "Ins" ? "Instagram" : p);
      parts.push(`**投放平台**: ${normalizedPlatforms.join("、")}`);
    }
    
    if (info.region) {
      const regions = Array.isArray(info.region) ? info.region : [info.region];
      parts.push(`**投放地区**: ${regions.join("、")}`);
    }
    
    if (info.publishTimeRange) {
      parts.push(`**发布时间段**: ${info.publishTimeRange}`);
    }
    
    if (info.budget !== null && info.budget !== undefined) {
      parts.push(`**预算**: $${info.budget.toLocaleString()} USD`);
    }
    
    if (info.commission !== null && info.commission !== undefined) {
      parts.push(`**佣金**: ${info.commission}%`);
    }
    
    return parts.join("\n");
  }

  /**
   * 使用 LLM 生成补充缺失 Campaign 字段的话术
   * 语气要求：与 ProductInfoAgent / ContentRequirementAgent 等保持一致，专业、清晰、偏商务，不用口头语和表情符号
   * @param {Object} info - 当前已收集到的 campaign 信息
   * @param {Array<string>} missingFields - 缺失字段列表
   * @returns {Promise<string>}
   */
  async generateMissingInfoReply(info, missingFields) {
    const fieldNames = {
      platform: "投放平台",
      region: "投放地区",
      publishTimeRange: "发布时间段",
      budget: "预算",
      commission: "佣金",
    };

    const missingFieldDisplay = missingFields
      .map((f) => fieldNames[f] || f)
      .map((name) => `- ${name}：`)
      .join("\n");

    const currentInfoText = this.formatCampaignInfo(info) || "（目前还没有已确认的 Campaign 信息）";

    const prompt = `你是一名负责对接品牌广告主的运营，同其他子 Agent 一样，沟通语气需专业、清晰、偏商务。

下面是目前已确认的 Campaign 相关信息（给客户看的 Markdown 文本）：

${currentInfoText}

现在还有一些 Campaign 字段没有补齐，请你输出一段给客户看的中文话术，引导客户补充这些信息。

具体要求：
1. 口吻专业、克制、自然，像资深广告运营对客户的正式书面回复，不使用口语化词汇（如“啦”、“呀”、“哈”等），也不要使用表情符号。
2. 可以先简要确认「前面信息已记录」或「产品信息已确认」，再说明「还需要补充哪些信息」。
3. 清晰列出需要补充的字段，每个字段单独一行，格式类似「投放平台：」。
4. 结尾用简洁的推进语，例如「请补充以上信息，我们即可进入下一步。」。
5. 只返回最终给客户看的中文话术，不要解释、不用说明你是谁，也不要返回 JSON。

当前缺失的字段如下（请据此生成话术，不要直接原样复制这段提示）：
${missingFieldDisplay}`;

    const reply = await callDeepSeekLLM(
      [{ role: "user", content: prompt }],
      "你是一名资深广告运营，用自然、口语化但专业的中文和客户沟通。"
    );

    return (reply || "").trim();
  }
}

