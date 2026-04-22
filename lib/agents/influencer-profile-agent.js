// 子 Agent 3: 确认红人画像 Agent
import { BaseAgent } from "./base-agent.js";
import { callDeepSeekLLM } from "../utils/llm-client.js";
import { generateSearchKeywords } from "../tools/influencer-functions/generate-search-keywords.js";
import { searchAndExtractInfluencers } from "../tools/influencer-functions/search-and-extract-influencers.js";

export class InfluencerProfileAgent extends BaseAgent {
  constructor() {
    const systemPrompt = `你是红人画像推荐专家。你的任务是与用户确认红人画像要求，并按用户选择决定是否生成红人名单。

 三阶段流程：
1. **阶段一**：仅根据产品与 Campaign 信息给出「建议的红人类型」（账户类型），不要直接给出粉丝量和播放量区间。需要主动向品牌方确认：对红人类型、粉丝量、播放量等画像是否有具体要求，并根据用户反馈更新画像要求，直到用户确认。
2. **阶段二**：画像确认后询问用户「是否需要现在找一批红人名单和你确认，还是直接下一步」。若用户要名单则执行找红人并返回名单与 CSV；若用户选择直接下一步则进入下一阶段。
3. **阶段三**：若已出示红人名单，则询问「是否需要调整红人画像要求」。不需要调整则直接下一步；需要调整则在用户确认调整后的画像要求后进入下一步，不再重新找红人名单。用户也可指出「第X个不要」以替换个别账户。

 回复要专业、清晰，用中文与客户沟通。`;

    super("InfluencerProfileAgent", systemPrompt);
  }

  /**
   * 推荐红人画像和账户
   * @param {Array} messages - 消息历史
   * @param {Object} context - 上下文（包含 productInfo 和 campaignInfo）
   * @param {Function} onStepUpdate - 步骤更新回调函数（可选，用于展示执行过程）
   * @returns {Promise<Object>} - { reply: string, influencerProfile: Object, influencers: Array, isConfirmed: boolean }
   */
  async recommendInfluencers(messages, context = {}, onStepUpdate = null) {
    try {
      const productInfo = context.productInfo || {};
      const campaignInfo = context.campaignInfo || {};
      const existingProfile = context.influencerProfile || null;
      const existingInfluencers = context.influencers || [];
      const lastMessage = (messages[messages.length - 1]?.content || "").trim();

      // ---------- 阶段 1：尚无红人画像 → 只给红人类型建议，不找红人 ----------
      if (!existingProfile) {
        const rawProfile = await this.generateProfileRequirements(
          productInfo,
          campaignInfo,
          null
        );
        const influencerProfile = {
          // 先锁定推荐的红人类型，粉丝量 / 播放量由品牌方补充后再确认
          accountType: rawProfile.accountType || "通用",
          followerRange: null,
          viewRange: null,
        };
        const reply = `基于你的产品与 Campaign 信息，我建议优先考虑 **${influencerProfile.accountType}** 类型的红人。

接下来需要与你一起确认更具体的红人画像要求：
- 粉丝量大概希望是多少范围？（例如：1万以上、1万-5万、10万-50万等）
- 视频平均播放量大概希望是多少范围？（例如：1万以上、1万-5万等）
- 红人类型上是否有额外偏好或限制？

请告诉我你对红人类型、粉丝量和播放量的具体要求，或者说「没有特别要求，按你建议来」，我会据此整理出一版完整的红人画像供你确认。`;
        return {
          reply,
          influencerProfile,
          influencers: [],
          isConfirmed: false,
          meta: { influencerStep: "profile_only" },
        };
      }

      const isAdjusting = this.detectAdjustmentRequest(lastMessage);
      let newProfileRequirements = null;
      let invalidInfluencerIndices = [];
      if (isAdjusting) {
        newProfileRequirements = await this.extractProfileRequirements(messages, existingProfile);
        invalidInfluencerIndices = await this.detectInvalidInfluencers(messages, existingInfluencers);
      }

      // ---------- 阶段 2：已有画像、尚无名单 → LLM 意图识别：下一步 / 要名单 / 确认画像 / 调整画像 ----------
      if (existingInfluencers.length === 0) {
        const phase2Intent = await this.detectPhase2Intent(messages, context);
        if (phase2Intent === "next_step") {
          return {
            reply: "好的，直接进入下一步。",
            influencerProfile: existingProfile,
            influencers: [],
            isConfirmed: true,
            meta: { influencerStep: null },
          };
        }
        if (phase2Intent === "want_list") {
          const influencers = await this.generateInfluencerAccountsWithFunctions(
            existingProfile,
            productInfo,
            campaignInfo,
            onStepUpdate,
            lastMessage
          );
          const listReply = this.formatRecommendationMessage(existingProfile, influencers, false);
          const reply = `${listReply}\n\n是否需要调整红人画像要求？不需要调整就直接下一步；需要调整则在确认调整后的红人画像要求后进入下一步，不再找红人名单。`;
          return {
            reply,
            influencerProfile: existingProfile,
            influencers,
            isConfirmed: false,
            meta: { influencerStep: "asked_adjust_profile_after_list" },
          };
        }
        if (phase2Intent === "confirm_profile") {
          const profileConfirmed = await this.detectConfirmation(messages, { ...context, influencerProfile: existingProfile, influencers: [] });
          if (profileConfirmed) {
            return {
              reply: "红人画像要求已确认。是否需要现在找一批红人名单和你确认，还是直接下一步？",
              influencerProfile: existingProfile,
              influencers: [],
              isConfirmed: false,
              meta: { influencerStep: "asked_list_or_next" },
            };
          }
        }
        if (phase2Intent === "adjust_profile" || isAdjusting) {
          const reqs = newProfileRequirements || await this.extractProfileRequirements(messages, existingProfile);
          if (this.isProfileRequirementsEmpty(reqs)) {
            const reply = `你提到需要调整红人画像。请说明要调整哪一项（粉丝量、播放量、账户类型），或直接说「不需要调整」进入下一步。`;
            return {
              reply,
              influencerProfile: existingProfile,
              influencers: [],
              isConfirmed: false,
              meta: { influencerStep: context.influencerStep || "profile_only" },
            };
          }
          const influencerProfile = await this.generateProfileRequirements(productInfo, campaignInfo, reqs);
          const reply = `已根据你的要求更新红人画像：\n\n**粉丝量**：${influencerProfile.followerRange || "未指定"}\n**播放量**：${influencerProfile.viewRange || "未指定"}\n**账户类型**：${influencerProfile.accountType || "未指定"}\n\n请确认红人画像是否需要调整。`;
          return {
            reply,
            influencerProfile,
            influencers: [],
            isConfirmed: false,
            meta: { influencerStep: "profile_only" },
          };
        }
        const reply = `当前红人画像：\n\n**粉丝量**：${existingProfile.followerRange || "未指定"}\n**播放量**：${existingProfile.viewRange || "未指定"}\n**账户类型**：${existingProfile.accountType || "未指定"}\n\n请确认红人画像是否需要调整。`;
        return {
          reply,
          influencerProfile: existingProfile,
          influencers: [],
          isConfirmed: false,
          meta: { influencerStep: context.influencerStep || "profile_only" },
        };
      }

      // ---------- 阶段 3：已有画像和名单 → 用 context.influencerStep + LLM 意图识别 ----------
      const step = context.influencerStep || "";

      if (step === "asked_confirm_updated_profile") {
        const confirmed = await this.detectConfirmation(messages, { ...context, influencerProfile: existingProfile, influencers: existingInfluencers });
        if (confirmed) {
          return {
            reply: "好的，调整后的红人画像要求已确认，直接进入下一步。",
            influencerProfile: context.influencerProfile || existingProfile,
            influencers: existingInfluencers,
            isConfirmed: true,
            meta: { influencerStep: null },
          };
        }
        const profile = context.influencerProfile || existingProfile;
        const replyAgain = `当前红人画像：\n\n**粉丝量**：${profile.followerRange || "未指定"}\n**播放量**：${profile.viewRange || "未指定"}\n**账户类型**：${profile.accountType || "未指定"}\n\n请确认调整后的红人画像要求，确认后进入下一步。`;
        return {
          reply: replyAgain,
          influencerProfile: profile,
          influencers: existingInfluencers,
          isConfirmed: false,
          meta: { influencerStep: "asked_confirm_updated_profile" },
        };
      }

      if (step === "asked_adjust_profile_after_list") {
        const phase3Intent = await this.detectPhase3Intent(messages, context);
        if (phase3Intent === "no_profile_adjustment") {
          return {
            reply: "好的，直接进入下一步。",
            influencerProfile: existingProfile,
            influencers: existingInfluencers,
            isConfirmed: true,
            meta: { influencerStep: null },
          };
        }
        if (phase3Intent === "want_profile_adjustment" && isAdjusting) {
          const reqs = newProfileRequirements || await this.extractProfileRequirements(messages, existingProfile);
          if (this.isProfileRequirementsEmpty(reqs)) {
            const reply = `你提到需要调整红人画像要求。请说明要调整哪一项（粉丝量、播放量、账户类型），或直接说「不需要调整」进入下一步。`;
            return {
              reply,
              influencerProfile: existingProfile,
              influencers: existingInfluencers,
              isConfirmed: false,
              meta: { influencerStep: "asked_adjust_profile_after_list" },
            };
          }
          const updatedProfile = await this.generateProfileRequirements(productInfo, campaignInfo, reqs);
          const reply = `已根据你的要求更新红人画像：\n\n**粉丝量**：${updatedProfile.followerRange || "未指定"}\n**播放量**：${updatedProfile.viewRange || "未指定"}\n**账户类型**：${updatedProfile.accountType || "未指定"}\n\n请确认调整后的红人画像要求，确认后进入下一步。`;
          return {
            reply,
            influencerProfile: updatedProfile,
            influencers: existingInfluencers,
            isConfirmed: false,
            meta: { influencerStep: "asked_confirm_updated_profile" },
          };
        }
      }

      // 用户指出「第X个不要」等 → 仅替换不符合的账户（不再整体重新找名单）；其余情况保留原名单
      let influencerProfile = existingProfile && !isAdjusting ? existingProfile : await this.generateProfileRequirements(productInfo, campaignInfo, newProfileRequirements);
      let influencers;
      if (invalidInfluencerIndices.length > 0 && existingInfluencers.length > 0) {
        influencers = await this.replaceInvalidInfluencers(
          existingInfluencers,
          invalidInfluencerIndices,
          influencerProfile,
          productInfo,
          campaignInfo
        );
      } else {
        influencers = existingInfluencers;
      }

      const listReply = this.formatRecommendationMessage(influencerProfile, influencers, isAdjusting);
      const reply = `${listReply}\n\n是否需要调整红人画像要求？不需要调整就直接下一步；需要调整则在确认调整后的红人画像要求后进入下一步，不再找红人名单。`;
      return {
        reply,
        influencerProfile,
        influencers,
        isConfirmed: false,
        meta: { influencerStep: "asked_adjust_profile_after_list" },
      };
    } catch (error) {
      console.error("[InfluencerProfileAgent] 推荐红人失败:", error);
      return {
        reply: `抱歉，推荐红人画像时遇到问题：${error.message}。\n\n请告诉我你的具体要求，或者稍后重试。`,
        influencerProfile: context.influencerProfile || null,
        influencers: [],
        meta: { influencerStep: null },
      };
    }
  }

  /**
   * 阶段二意图识别（LLM）：已有画像、尚无名单时，用户是选「直接下一步」「要红人名单」还是「确认画像」
   * @param {Array} messages - 消息历史
   * @param {Object} context - 上下文
   * @returns {Promise<'next_step'|'want_list'|'confirm_profile'|'adjust_profile'>}
   */
  async detectPhase2Intent(messages, context = {}) {
    const conversationHistory = messages.slice(-4).map(m => `${m.role}: ${m.content}`).join("\n");
    const prompt = `根据对话判断用户在当前红人画像环节的意图。

对话历史（最近几条）：
${conversationHistory}

当前状态：已展示红人画像建议，并询问「是否需要现在找一批红人名单和你确认，还是直接下一步」。

请判断用户意图，只返回以下之一（不要其他文字）：
- next_step：用户选择直接下一步、不需要名单、暂不找红人等
- want_list：用户要红人名单、需要找一批红人、找红人等
- confirm_profile：用户确认红人画像要求（确认、可以、没问题等），尚未明确选名单或下一步
- adjust_profile：用户要求调整红人画像（改粉丝量、播放量、账户类型等）

只返回 JSON：
{ "intent": "next_step" | "want_list" | "confirm_profile" | "adjust_profile" }`;

    try {
      const llmResponse = await callDeepSeekLLM(
        [{ role: "user", content: prompt }],
        "你是指意图识别专家。只返回 JSON，不要其他文字。"
      );
      const jsonMatch = llmResponse.match(/\{[\s\S]*\}/);
      const parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : {};
      return parsed.intent || "confirm_profile";
    } catch (e) {
      console.warn("[InfluencerProfileAgent] detectPhase2Intent 失败:", e);
      return "confirm_profile";
    }
  }

  /**
   * 阶段三意图识别（LLM）：已出示红人名单并问「是否调整画像」时，用户是「不调整/下一步」还是「要调整画像」
   * @param {Array} messages - 消息历史
   * @param {Object} context - 上下文
   * @returns {Promise<'no_profile_adjustment'|'want_profile_adjustment'|'replace_accounts'|'unknown'>}
   */
  async detectPhase3Intent(messages, context = {}) {
    const conversationHistory = messages.slice(-4).map(m => `${m.role}: ${m.content}`).join("\n");
    const prompt = `根据对话判断用户意图。

对话历史（最近几条）：
${conversationHistory}

当前状态：已出示红人名单，并询问「是否需要调整红人画像要求？不需要调整就直接下一步；需要调整则在确认调整后的红人画像要求后进入下一步」。

请判断用户意图，只返回以下之一：
- no_profile_adjustment：用户表示不需要调整、确认、直接下一步、可以、没问题等（进入下一步）
- want_profile_adjustment：用户表示要调整红人画像要求（粉丝量、播放量、账户类型等）
- replace_accounts：用户指出名单中某些人不要（如第X个不要、换掉第X个）
- unknown：无法判断

只返回 JSON：
{ "intent": "no_profile_adjustment" | "want_profile_adjustment" | "replace_accounts" | "unknown" }`;

    try {
      const llmResponse = await callDeepSeekLLM(
        [{ role: "user", content: prompt }],
        "你是指意图识别专家。只返回 JSON，不要其他文字。"
      );
      const jsonMatch = llmResponse.match(/\{[\s\S]*\}/);
      const parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : {};
      return parsed.intent || "unknown";
    } catch (e) {
      console.warn("[InfluencerProfileAgent] detectPhase3Intent 失败:", e);
      return "unknown";
    }
  }

  /** 判断画像要求对象是否为空（未提取到具体项） */
  isProfileRequirementsEmpty(reqs) {
    if (!reqs || typeof reqs !== "object") return true;
    const v = (x) => x === null || x === undefined || (typeof x === "string" && !x.trim());
    return v(reqs.followerRange) && v(reqs.viewRange) && v(reqs.accountType);
  }

  /**
   * 检测用户是否要求调整画像或指出不符合的账户
   * @param {string} message - 用户消息
   * @returns {boolean}
   */
  detectAdjustmentRequest(message) {
    const lowerMessage = message.toLowerCase();
    const adjustmentKeywords = [
      "调整", "修改", "更改", "换", "重新", "不要", "不需要", "不符合", "不合适",
      "粉丝量", "播放量", "账户类型", "画像", "要求", "第", "个", "账户"
    ];
    
    return adjustmentKeywords.some(kw => lowerMessage.includes(kw));
  }

  /**
   * 检测用户指出哪些账户不符合要求
   * @param {Array} messages - 消息历史
   * @param {Array} existingInfluencers - 现有的账户列表
   * @returns {Promise<Array<number>>} - 不符合的账户索引数组（从1开始，需要转换为从0开始）
   */
  async detectInvalidInfluencers(messages, existingInfluencers) {
    const lastMessage = messages[messages.length - 1]?.content || "";
    const conversationHistory = messages.slice(-3).map(m => `${m.role}: ${m.content}`).join("\n");
    
    const extractionPrompt = `从以下对话中提取用户指出哪些账户不符合要求。

对话历史：
${conversationHistory}

现有账户列表：
${existingInfluencers.map((inf, index) => `${index + 1}. ${inf.name || inf.id}`).join("\n")}

用户可能说："第1个不符合"、"第2和第3个不要"、"第一个和最后一个换掉"等。

提取用户指出的账户编号（从1开始），返回数组。

只返回 JSON 格式：
{
  "invalidIndices": [1, 3] | []  // 账户编号数组，从1开始
}`;

    try {
      const llmResponse = await callDeepSeekLLM(
        [{ role: "user", content: extractionPrompt }],
        "你是一个信息提取专家，擅长从对话中提取结构化信息。只返回 JSON 格式，不要其他文字。"
      );

      try {
        const result = JSON.parse(llmResponse);
        // 转换为从0开始的索引
        return (result.invalidIndices || []).map(idx => idx - 1).filter(idx => idx >= 0 && idx < existingInfluencers.length);
      } catch (e) {
        const jsonMatch = llmResponse.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          const result = JSON.parse(jsonMatch[0]);
          return (result.invalidIndices || []).map(idx => idx - 1).filter(idx => idx >= 0 && idx < existingInfluencers.length);
        }
        return [];
      }
    } catch (error) {
      console.warn("[InfluencerProfileAgent] 提取不符合账户失败:", error);
      return [];
    }
  }

  /**
   * 从用户消息中提取新的画像要求
   * @param {Array} messages - 消息历史
   * @param {Object} existingProfile - 现有的画像要求
   * @returns {Promise<Object>} - 新的画像要求
   */
  async extractProfileRequirements(messages, existingProfile) {
    const conversationHistory = messages.slice(-5).map(m => `${m.role}: ${m.content}`).join("\n");
    
    const extractionPrompt = `从以下对话中提取用户对红人画像的新要求。

对话历史：
${conversationHistory}

现有画像要求：
${JSON.stringify(existingProfile, null, 2)}

提取用户提到的新要求，包括：
- followerRange（粉丝量范围）：必须保留用户原始表达，尤其是阈值表达（如"大于1万"、">=10000"、"1万-5万"）。
- viewRange（播放量范围）：必须保留用户原始表达，尤其是阈值表达（如"大于1000"、">1000"、"1千-1万"）。
- accountType（账户类型）：保留用户给出的类型与人群特征，不要丢失限定词（例如"时尚、服装、家居类目白人年轻女性"）。

如果用户没有提到某项，该项为 null。

强约束：
1) 只提取用户明确说过的内容，不要脑补成更高档位（例如把"大于1万"改成"10万-50万"是错误的）。
2) 如果用户说的是下限条件（大于/不少于/至少），就按下限条件原样返回，不要改写成区间。
3) 若用户一次给出多个类型标签，accountType 应合并保留，不要只保留其中一个。

只返回 JSON 格式：
{
  "followerRange": "大于1万" | null,
  "viewRange": "大于1000" | null,
  "accountType": "时尚、服装、家居类目白人年轻女性" | null
}`;

    try {
      const llmResponse = await callDeepSeekLLM(
        [{ role: "user", content: extractionPrompt }],
        "你是一个信息提取专家，擅长从对话中提取结构化信息。只返回 JSON 格式，不要其他文字。"
      );

      try {
        return JSON.parse(llmResponse);
      } catch (e) {
        const jsonMatch = llmResponse.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          return JSON.parse(jsonMatch[0]);
        }
        return {};
      }
    } catch (error) {
      console.warn("[InfluencerProfileAgent] 提取画像要求失败:", error);
      return {};
    }
  }

  /**
   * 生成红人画像要求
   * @param {Object} productInfo - 产品信息
   * @param {Object} campaignInfo - Campaign 信息
   * @param {Object} userRequirements - 用户的新要求（可选）
   * @returns {Promise<Object>} - 红人画像要求
   */
  async generateProfileRequirements(productInfo, campaignInfo, userRequirements = null) {
    const prompt = `基于以下信息，输出红人画像要求。

产品信息：
${JSON.stringify(productInfo, null, 2)}

Campaign 信息：
${JSON.stringify(campaignInfo, null, 2)}

${userRequirements ? `用户新要求：\n${JSON.stringify(userRequirements, null, 2)}` : ""}

输出字段包括：
1. followerRange（粉丝量范围）
2. viewRange（播放量范围）
3. accountType（账户类型）

决策规则（非常重要）：
1) 若存在 userRequirements，必须“用户要求优先”，逐字段覆盖，不得擅自抬高门槛或改成其他区间。
   - 例如用户给出 "大于1万"，就返回 "大于1万"；
   - 用户给出 "大于1000"，就返回 "大于1000"；
   - 严禁改写为 "10万-50万" 这类未被用户明确提出的值。
2) accountType 必须保留用户给出的全部关键限定词（类目、人群、性别、年龄、地区/种族等），不要仅保留泛化词（如只写"时尚博主"）。
3) 仅当 userRequirements 某字段为 null 或空时，才可基于产品/Campaign 做合理补全。
4) 输出尽量沿用中文原词，不做主观美化。
5) 当 userRequirements 为空时，accountType 必须根据产品信息与 Campaign 信息动态推导，禁止使用固定默认画像（例如固定返回"时尚、服装、家居类目白人年轻女性"）。

只返回 JSON 格式：
{
  "followerRange": "根据产品与Campaign信息推导的范围",
  "viewRange": "根据产品与Campaign信息推导的范围",
  "accountType": "根据产品与Campaign信息推导的账户类型"
}`;

    try {
      const llmResponse = await callDeepSeekLLM(
        [{ role: "user", content: prompt }],
        "你是一个红人营销专家，擅长推荐合适的红人画像要求。只返回 JSON 格式，不要其他文字。"
      );

      try {
        const parsed = JSON.parse(llmResponse);
        return this.normalizeGeneratedProfile(parsed, productInfo, campaignInfo, userRequirements);
      } catch (e) {
        const jsonMatch = llmResponse.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          const parsed = JSON.parse(jsonMatch[0]);
          return this.normalizeGeneratedProfile(parsed, productInfo, campaignInfo, userRequirements);
        }
        // 降级：返回默认值
        return {
          followerRange: "10万-50万",
          viewRange: "10万-50万",
          accountType: "通用",
        };
      }
    } catch (error) {
      console.warn("[InfluencerProfileAgent] 生成画像要求失败，使用默认值:", error);
      return {
        followerRange: "10万-50万",
        viewRange: "10万-50万",
        accountType: "通用",
      };
    }
  }

  /**
   * 规范化画像输出，避免在无用户要求时落入固定模板画像
   * @param {Object} profile
   * @param {Object} productInfo
   * @param {Object} campaignInfo
   * @param {Object|null} userRequirements
   * @returns {Object}
   */
  normalizeGeneratedProfile(profile, productInfo, campaignInfo, userRequirements) {
    const safeProfile = {
      followerRange: profile?.followerRange || null,
      viewRange: profile?.viewRange || null,
      accountType: profile?.accountType || "通用",
    };

    // 仅在用户未明确给画像要求时，拦截常见固定模板输出并做动态兜底
    if (!userRequirements && typeof safeProfile.accountType === "string") {
      const normalized = safeProfile.accountType.replace(/\s+/g, "").toLowerCase();
      if (normalized.includes("时尚、服装、家居类目白人年轻女性".replace(/\s+/g, "").toLowerCase())) {
        safeProfile.accountType = this.inferDynamicAccountType(productInfo, campaignInfo);
      }
    }

    return safeProfile;
  }

  /**
   * 基于产品和 campaign 简单推断账户类型，作为固定模板兜底替换
   * @param {Object} productInfo
   * @param {Object} campaignInfo
   * @returns {string}
   */
  inferDynamicAccountType(productInfo, campaignInfo) {
    const text = `${JSON.stringify(productInfo || {})} ${JSON.stringify(campaignInfo || {})}`.toLowerCase();
    const profileTags = [];

    if (/(beauty|cosmetic|makeup|skincare|护肤|美妆|彩妆)/.test(text)) profileTags.push("美妆护肤");
    if (/(fashion|apparel|clothing|outfit|时尚|服装|穿搭)/.test(text)) profileTags.push("时尚穿搭");
    if (/(home|furniture|decor|家居|家装|收纳)/.test(text)) profileTags.push("家居生活");
    if (/(fitness|workout|gym|健身|运动)/.test(text)) profileTags.push("运动健身");
    if (/(food|recipe|snack|餐饮|美食)/.test(text)) profileTags.push("美食");
    if (/(tech|gadget|3c|数码|科技)/.test(text)) profileTags.push("科技数码");

    if (profileTags.length > 0) return `${Array.from(new Set(profileTags)).join("、")}类目创作者`;
    return "与产品匹配的垂类创作者";
  }

  /**
   * 使用5个函数逐步生成红人账户列表（展示执行过程）
   * @param {Object} profile - 红人画像要求
   * @param {Object} productInfo - 产品信息
   * @param {Object} campaignInfo - Campaign 信息
   * @param {Function} onStepUpdate - 步骤更新回调函数
   * @param {string} userMessage - 用户消息（可选）
   * @returns {Promise<Array>} - 红人账户列表
   */
  async generateInfluencerAccountsWithFunctions(profile, productInfo, campaignInfo, onStepUpdate = null, userMessage = "") {
    const sendStep = (step) => {
      if (onStepUpdate) {
        onStepUpdate({
          agent: "InfluencerProfileAgent",
          action: step.action,
          result: step.result,
          timestamp: new Date().toISOString()
        });
      }
    };

    try {
      // 转换画像要求格式
      const influencerProfile = {
        accountType: profile.accountType,
        minFollowers: this.parseFollowerRange(profile.followerRange)?.[0],
        maxFollowers: this.parseFollowerRange(profile.followerRange)?.[1],
      };

      // 转换 campaignInfo 格式
      const normalizedCampaignInfo = {
        platforms: Array.isArray(campaignInfo.platform) 
          ? campaignInfo.platform.map(p => p === "Ins" ? "Instagram" : p)
          : campaignInfo.platform 
            ? [campaignInfo.platform === "Ins" ? "Instagram" : campaignInfo.platform]
            : [],
        countries: Array.isArray(campaignInfo.region)
          ? campaignInfo.region
          : campaignInfo.region
            ? [campaignInfo.region]
            : [],
        publishTimeRange: campaignInfo.publishTimeRange,
        budget: campaignInfo.budget,
        commission: campaignInfo.commission,
      };

      // 函数1: 生成搜索关键词
      sendStep({
        action: "函数1: 生成搜索关键词",
        result: "正在基于产品信息、Campaign信息和红人画像要求生成搜索关键词..."
      });
      
      const keywordsResult = await generateSearchKeywords({
        productInfo,
        campaignInfo: normalizedCampaignInfo,
        influencerProfile,
        userMessage
      });

      if (!keywordsResult.success || !keywordsResult.search_queries || keywordsResult.search_queries.length === 0) {
        throw new Error('关键词生成失败');
      }

      sendStep({
        action: "函数1: 生成搜索关键词",
        result: `✅ 成功生成${keywordsResult.search_queries.length}个搜索查询: ${keywordsResult.search_queries.slice(0, 3).join(', ')}...`
      });

      // 函数2: 搜索并提取红人数据
      sendStep({
        action: "函数2: 搜索并提取红人数据",
        result: "正在搜索社媒平台并提取红人和视频数据..."
      });

      const searchResult = await searchAndExtractInfluencers({
        keywords: { search_queries: keywordsResult.search_queries },
        platforms: normalizedCampaignInfo.platforms,
        countries: normalizedCampaignInfo.countries,
        productInfo,
        campaignInfo: normalizedCampaignInfo,
        influencerProfile
      }, {
        maxResults: 5,
        searchLimit: 5,
        maxEnrichCount: 5,
        useCache: true,
        timeout: 30000,
        onStepUpdate: onStepUpdate
      });

      if (!searchResult.success || !searchResult.influencers || searchResult.influencers.length === 0) {
        throw new Error('搜索红人失败或未找到结果');
      }

      const totalAnalyzed = searchResult.influencers.length;
      sendStep({
        action: "函数2: 搜索并提取红人数据",
        result: `✅ 已完成搜索、主页提取与匹配分析，共分析 **${totalAnalyzed} 位红人**。正在生成总结...`
      });

      // 直接使用 pipeline 返回的红人列表（已含 isRecommended、score、reason 等），转换为前端格式并返回
      const influencersForReply = searchResult.influencers.map(inf => ({
        id: inf.username,
        name: inf.displayName || inf.username,
        profileUrl: inf.profileUrl,
        avatar: inf.avatarUrl || inf.avatar || '',
        platform: inf.platform || 'TikTok',
        followers: inf.followers?.display ?? inf.followers ?? '0',
        views: inf.views?.display ?? inf.views ?? '0',
        cpm: inf.cpm != null ? `$${Number(inf.cpm).toFixed(2)}` : 'N/A',
        reason: inf.reason || inf.recommendationReason || (inf.isRecommended ? '符合画像要求' : '综合匹配度未达推荐线'),
        score: inf.score != null ? inf.score : null,
        isRecommended: inf.isRecommended !== undefined ? inf.isRecommended : null,
        analysis: inf.analysis || inf.recommendationAnalysis || null
      }));

      return influencersForReply;

    } catch (error) {
      console.error('[generateInfluencerAccountsWithFunctions] 执行失败:', error);
      sendStep({
        action: "执行失败",
        result: `❌ 错误: ${error.message}`
      });
      
      // 直接抛出错误，不使用降级方案
      throw error;
    }
  }

  /**
   * 解析粉丝量范围字符串为数字范围
   * @param {string} range - 如 "10万-50万"
   * @returns {[number, number]|null} - [min, max] 或 null
   */
  parseFollowerRange(range) {
    if (!range || typeof range !== 'string') return null;
    
    const match = range.match(/(\d+(?:\.\d+)?)万?\s*-\s*(\d+(?:\.\d+)?)万?/);
    if (match) {
      const min = parseFloat(match[1]) * 10000;
      const max = parseFloat(match[2]) * 10000;
      return [min, max];
    }
    
    return null;
  }

  /**
   * 替换不符合要求的账户
   * @param {Array} existingInfluencers - 现有的账户列表
   * @param {Array<number>} invalidIndices - 不符合的账户索引（从0开始）
   * @param {Object} profile - 红人画像要求
   * @param {Object} productInfo - 产品信息
   * @param {Object} campaignInfo - Campaign 信息
   * @returns {Promise<Array>} - 更新后的账户列表
   */
  async replaceInvalidInfluencers(existingInfluencers, invalidIndices, profile, productInfo, campaignInfo) {
    // 生成新的账户来替换不符合的（使用新的函数方法）
    const newInfluencers = await this.generateInfluencerAccountsWithFunctions(profile, productInfo, campaignInfo);
    
    // 创建结果数组，保留符合要求的账户，替换不符合的
    const result = [...existingInfluencers];
    
    // 为每个不符合的账户生成替代账户
    for (let i = 0; i < invalidIndices.length; i++) {
      const invalidIndex = invalidIndices[i];
      if (invalidIndex >= 0 && invalidIndex < result.length) {
        // 从新生成的账户中选择一个（避免重复）
        const replacementIndex = i % newInfluencers.length;
        const replacement = newInfluencers[replacementIndex];
        
        // 确保ID唯一，但保留平台信息
        result[invalidIndex] = {
          ...replacement,
          id: `${replacement.id}_replacement_${i}`,
          name: replacement.name, // 不添加"替换"标记，保持简洁
          platform: replacement.platform || (replacement.profileUrl?.includes('instagram.com') ? 'Instagram' : 'TikTok'),
        };
      }
    }
    
    return result;
  }

  /**
   * 格式化推荐消息
   * @param {Object} profile - 红人画像要求
   * @param {Array} influencers - 红人账户列表
   * @param {boolean} isAdjusting - 是否在调整
   * @returns {string}
   */
  formatRecommendationMessage(profile, influencers, isAdjusting) {
    const totalCount = influencers.length;
    const recommendedList = influencers
      .filter(inf => inf.isRecommended === true || (inf.score || 0) >= 60);
    const recommendedCount = recommendedList.length;

    // ---------- 生成 CSV 数据（红人名单文件：红人、基础数据、是否推荐、理由等） ----------
    const csvHeaders = [
      "username",
      "name",
      "profile_url",
      "platform",
      "followers",
      "views",
      "score",
      "is_recommended",
      "reason"
    ];

    const escapeCsv = (value) => {
      if (value === null || value === undefined) return "";
      const str = String(value).replace(/"/g, '""');
      return `"${str}"`;
    };

    const csvRows = influencers.map((inf) => {
      const username = inf.id || "";
      const name = inf.name || "";
      const profileUrl = inf.profileUrl || "";
      const platform = inf.platform || (profileUrl.includes("instagram.com") ? "Instagram" : "TikTok");
      const followers = inf.followers || "";
      const views = inf.views || "";
      const score = inf.score != null ? inf.score : "";
      const isRecommended = inf.isRecommended === true ? "1" : (inf.isRecommended === false ? "0" : "");
      const reason = inf.reason || "";

      return [
        escapeCsv(username),
        escapeCsv(name),
        escapeCsv(profileUrl),
        escapeCsv(platform),
        escapeCsv(followers),
        escapeCsv(views),
        escapeCsv(score),
        escapeCsv(isRecommended),
        escapeCsv(reason),
      ].join(",");
    });

    const csvContent = [csvHeaders.join(","), ...csvRows].join("\n");
    const csvDataUrl = `data:text/csv;charset=utf-8,${encodeURIComponent(csvContent)}`;
    const csvLinkText = `[下载本次红人名单 CSV](${csvDataUrl})`;

    const intro = isAdjusting
      ? "我已经根据你的要求调整了推荐。分析了"
      : "我按照你的红人画像要求，分析了";
    const summary = `${intro} **${totalCount}** 位红人，推荐 **${recommendedCount}** 位。以下是红人名单。如果红人画像要求没问题，我们下一步。（附红人名单文件，含红人、基础数据、是否推荐、理由等）\n\n${csvLinkText}`;

    return summary;
  }

  /**
   * 检测用户是否确认红人画像
   * @param {Array} messages - 消息历史
   * @param {Object} context - 上下文（包含 influencerProfile、influencers）
   * @returns {Promise<boolean>} - 是否确认
   */
  async detectConfirmation(messages, context = {}) {
    const lastMessage = messages[messages.length - 1]?.content || "";
    const influencerProfile = context.influencerProfile;
    const influencers = context.influencers || [];
    const conversationHistory = messages.slice(-3).map(m => `${m.role}: ${m.content}`).join("\n");

    // 如果没有红人画像，不需要判断确认
    if (!influencerProfile) {
      return false;
    }

    const prompt = `判断用户是否确认了红人画像推荐。

对话历史：
${conversationHistory}

红人画像要求：
- 粉丝量：${influencerProfile.followerRange || "未指定"}
- 播放量：${influencerProfile.viewRange || "未指定"}
- 账户类型：${influencerProfile.accountType || "未指定"}

推荐红人账户数量：${influencers.length}个

如果用户确认红人画像（如"确认"、"正确"、"无误"、"可以"、"好的"、"行"、"没问题"、"继续"、"下一步"、"无需调整"、"不需要调整"等），返回 true。
如果用户要求调整画像或指出不符合的账户，返回 false。
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
      console.warn("[InfluencerProfileAgent] 判断确认失败:", error);
      return false;
    }
  }
}