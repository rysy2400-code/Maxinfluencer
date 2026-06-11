// 子 Agent 3: 确认红人画像 Agent
import { BaseAgent } from "./base-agent.js";
import { callDeepSeekLLM } from "../utils/llm-client.js";

/** 用户明确表示粉丝量/播放量无门槛时使用，搜索侧视为不限制 */
const PROFILE_NO_REQUIREMENT = "无要求";

function isNoRequirementText(text) {
  if (text == null) return false;
  const s = String(text).trim();
  if (!s) return false;
  return /^(无要求|没有要求|没有特别要求|无特别要求|不限|不限制|不设要求|无门槛|均可|随便|任意)$/i.test(
    s
  ) || /无要求|没有要求|没有特别要求|无特别要求|不限|不限制|不设要求/i.test(s);
}

function formatProfileFieldForDisplay(value) {
  if (value == null || value === "") return PROFILE_NO_REQUIREMENT;
  if (isNoRequirementText(value) || value === PROFILE_NO_REQUIREMENT) {
    return PROFILE_NO_REQUIREMENT;
  }
  return String(value);
}

export class InfluencerProfileAgent extends BaseAgent {
  constructor() {
    const systemPrompt = `你是红人画像推荐专家。你的任务是与用户确认红人画像要求（粉丝量、播放量、账户类型），确认后进入内容要求阶段。

流程：
1. 先根据产品与 Campaign 给出建议的红人类型（账户类型），再请用户补充粉丝量、播放量、账户类型要求。
2. 整理完整画像后请用户确认；用户表示不需要调整/确认无误时，画像即定稿并进入下一阶段。
3. 不在此阶段生成或展示红人名单。

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

      // ---------- 阶段 1：尚无红人画像 → 只给红人类型建议，不找红人 ----------
      if (!existingProfile) {
        const rawProfile = await this.generateProfileRequirements(
          productInfo,
          campaignInfo
        );
        const influencerProfile = {
          // 先锁定推荐的红人类型，粉丝量 / 播放量由品牌方补充后再确认
          accountType: rawProfile.accountType || "通用",
          followerRange: null,
          viewRange: null,
        };
        const reply = `基于你的产品与 Campaign 信息，我建议优先考虑 **${influencerProfile.accountType}** 类型的红人。

接下来需要与你一起确认更具体的红人画像要求：
粉丝量要求：
播放量要求
红人账户类型要求：

请告诉我你对红人类型、粉丝量和播放量的具体要求，或者说「没有特别要求，按你建议来」，我会据此整理出一版完整的红人画像供你确认。`;
        return {
          reply,
          influencerProfile,
          influencers: [],
          isConfirmed: false,
          meta: { influencerStep: "profile_only" },
        };
      }

      const profileComplete = this.isProfileMetricsComplete(existingProfile);
      const turnIntent = await this.detectProfileTurnIntent(
        messages,
        existingProfile,
        profileComplete
      );

      if (turnIntent === "confirm") {
        const influencerProfile = profileComplete
          ? existingProfile
          : await this.buildProfileFromConversation(
              messages,
            productInfo,
            campaignInfo,
              existingProfile
          );
          return {
          reply: "好的，红人画像已确认，正在进入内容要求确认。",
            influencerProfile,
            influencers: [],
            isConfirmed: true,
            meta: { influencerStep: null },
          };
        }

      if (turnIntent === "provide_or_update" || !profileComplete) {
        const influencerProfile = await this.buildProfileFromConversation(
          messages,
            productInfo,
            campaignInfo,
          existingProfile
          );
          const reply = `已根据你的要求更新红人画像：\n\n${this.formatProfileSummary(
            influencerProfile
          )}\n\n请确认红人画像是否需要调整。`;
          return {
            reply,
            influencerProfile,
            influencers: [],
            isConfirmed: false,
            meta: { influencerStep: "profile_only" },
          };
        }

        const reply = `当前红人画像：\n\n${this.formatProfileSummary(
          existingProfile
        )}\n\n请确认红人画像是否需要调整。`;
        return {
          reply,
          influencerProfile: existingProfile,
          influencers: [],
          isConfirmed: false,
        meta: { influencerStep: "profile_only" },
      };
    } catch (error) {
      console.error("[InfluencerProfileAgent] 推荐红人失败:", error);
      return {
        reply: `抱歉，确认红人画像时遇到问题：${error.message}。\n\n请告诉我你的具体要求，或者稍后重试。`,
        influencerProfile: context.influencerProfile || null,
        influencers: [],
        isConfirmed: false,
        meta: { influencerStep: null },
      };
    }
  }

  /** 粉丝量、播放量是否已收集（含「无要求」） */
  isProfileMetricsComplete(profile) {
    if (!profile || typeof profile !== "object") return false;
    const has = (v) =>
      v != null && String(v).trim() !== "" && String(v).trim() !== "null";
    return has(profile.followerRange) && has(profile.viewRange);
  }

  /**
   * 当前轮次意图（LLM）：确认画像 / 补充或修改要求 / 不明确
   * @returns {Promise<'confirm'|'provide_or_update'|'unclear'>}
   */
  async detectProfileTurnIntent(messages, existingProfile, profileComplete) {
    const conversationHistory = messages
      .slice(-6)
      .map((m) => `${m.role}: ${m.content}`)
      .join("\n");
    const prompt = `判断用户在「确认红人画像」环节的意图。

对话历史（最近几条）：
${conversationHistory}

当前画像（JSON）：
${JSON.stringify(existingProfile, null, 2)}

画像是否已包含粉丝量、播放量（含「无要求」）：${profileComplete ? "是" : "否"}

规则：
- confirm：用户确认画像、表示不需要调整/修改。包括「不需要」「不需要调整」「确认」「无误」「可以」「没问题」「OK」等；用户说「不需要」时一律视为确认画像（不再区分是否在问名单），返回 confirm。
- provide_or_update：用户在补充或修改粉丝量、播放量、账户类型；或说「没有特别要求，按你建议来」「按你建议」等，需要整理画像（注意：单独的「不需要」不是 provide_or_update）。
- unclear：无法判断或仅寒暄。

只返回 JSON：
{ "intent": "confirm" | "provide_or_update" | "unclear" }`;

    try {
      const llmResponse = await callDeepSeekLLM(
        [{ role: "user", content: prompt }],
        "你是指意图识别专家。只返回 JSON，不要其他文字。"
      );
      const jsonMatch = llmResponse.match(/\{[\s\S]*\}/);
      const parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : {};
      const intent = parsed.intent;
      if (intent === "confirm" || intent === "provide_or_update" || intent === "unclear") {
        return intent;
      }
      return "unclear";
    } catch (e) {
      console.warn("[InfluencerProfileAgent] detectProfileTurnIntent 失败:", e);
      return "unclear";
    }
  }

  /**
   * 单次 LLM 整理完整红人画像（替代分步提取+补全，依赖 prompt 约束）
   */
  async buildProfileFromConversation(
    messages,
    productInfo,
    campaignInfo,
      existingProfile
  ) {
    const conversationHistory = messages
      .slice(-8)
      .map((m) => `${m.role}: ${m.content}`)
      .join("\n");

    const prompt = `根据对话整理完整红人画像，输出 followerRange、viewRange、accountType 三个字段。

产品信息：
${JSON.stringify(productInfo, null, 2)}

Campaign 信息：
${JSON.stringify(campaignInfo, null, 2)}

当前已有画像（可能仅含 accountType）：
${JSON.stringify(existingProfile, null, 2)}

对话历史：
${conversationHistory}

决策规则（必须遵守）：
1) 三个字段都必须输出，不得省略。
2) 用户说「无要求」「没有要求」「没有特别要求」「不限」「按你建议来」「按你建议」等时：
   - followerRange 与 viewRange 必须输出 "无要求"（不要输出 null，不要编造 1万-10万、大于1000 等数字）。
3) 用户明确给出阈值或区间（如「大于1万」「1万-5万」）时，原样保留，禁止擅自改成更大区间。
4) accountType 保留用户全部限定词（如「女大学生」）；若用户未改账户类型，沿用当前已有 accountType 或结合产品/Campaign 推荐。
5) 用户同时说粉丝/播放无要求并指定账户类型时，followerRange 与 viewRange 均为 "无要求"，accountType 为用户指定类型。
6) 仅当用户完全未提及粉丝量/播放量且未说「按你建议来/无要求」时，才可基于 Campaign 做合理补全；一旦用户表达无要求，严禁补全为数字。

只返回 JSON：
{
  "followerRange": "无要求" | "大于1万" | "1万-5万" 等,
  "viewRange": "无要求" | "大于1000" 等,
  "accountType": "账户类型描述"
}`;

    try {
      const llmResponse = await callDeepSeekLLM(
        [{ role: "user", content: prompt }],
        "你是红人营销专家。严格按规则输出 JSON，不要其他文字。"
      );
      let parsed;
      try {
        parsed = JSON.parse(llmResponse);
      } catch {
        const jsonMatch = llmResponse.match(/\{[\s\S]*\}/);
        parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : {};
      }
      return {
        followerRange: this.normalizeProfileField(
          parsed.followerRange,
          existingProfile?.followerRange
        ),
        viewRange: this.normalizeProfileField(
          parsed.viewRange,
          existingProfile?.viewRange
        ),
        accountType:
          (typeof parsed.accountType === "string" && parsed.accountType.trim()) ||
          existingProfile?.accountType ||
          "通用",
      };
    } catch (error) {
      console.warn("[InfluencerProfileAgent] buildProfileFromConversation 失败:", error);
      return {
        followerRange: existingProfile?.followerRange ?? PROFILE_NO_REQUIREMENT,
        viewRange: existingProfile?.viewRange ?? PROFILE_NO_REQUIREMENT,
        accountType: existingProfile?.accountType || "通用",
      };
    }
  }

  formatProfileSummary(profile) {
    const p = profile || {};
    return `**粉丝量**：${formatProfileFieldForDisplay(p.followerRange)}\n**播放量**：${formatProfileFieldForDisplay(p.viewRange)}\n**账户类型**：${p.accountType || "未指定"}`;
  }

  normalizeProfileField(value, fallback = null) {
    if (isNoRequirementText(value)) return PROFILE_NO_REQUIREMENT;
    if (value != null && String(value).trim() && String(value).trim() !== "null") {
      return String(value).trim();
    }
    if (isNoRequirementText(fallback)) return PROFILE_NO_REQUIREMENT;
    if (fallback != null && String(fallback).trim()) return String(fallback).trim();
    return PROFILE_NO_REQUIREMENT;
  }

  /**
   * 阶段一：根据产品与 Campaign 推荐红人类型（accountType）
   */
  async generateProfileRequirements(productInfo, campaignInfo) {
    const prompt = `基于以下产品与 Campaign 信息，推荐一类适合合作的红人账户类型（accountType）。

产品信息：
${JSON.stringify(productInfo, null, 2)}

Campaign 信息：
${JSON.stringify(campaignInfo, null, 2)}

要求：
1) 只输出 accountType，需结合产品类目、目标人群、投放地区与平台，给出具体可执行的类型描述。
2) 禁止使用固定模板（例如千篇一律的「时尚、服装、家居类目白人年轻女性」）。
3) 不要输出粉丝量、播放量区间；此阶段仅推荐红人类型。

只返回 JSON：
{
  "accountType": "根据产品与Campaign推导的账户类型"
}`;

    try {
      const llmResponse = await callDeepSeekLLM(
        [{ role: "user", content: prompt }],
        "你是红人营销专家，擅长推荐合适的红人账户类型。只返回 JSON，不要其他文字。"
      );

      let parsed;
      try {
        parsed = JSON.parse(llmResponse);
      } catch {
        const jsonMatch = llmResponse.match(/\{[\s\S]*\}/);
        parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : {};
      }
      return this.normalizeGeneratedProfile(parsed, productInfo, campaignInfo);
    } catch (error) {
      console.warn("[InfluencerProfileAgent] 生成画像要求失败，使用兜底:", error);
      return {
        accountType: this.inferDynamicAccountType(productInfo, campaignInfo),
      };
    }
  }

  normalizeGeneratedProfile(profile, productInfo, campaignInfo) {
    let accountType = profile?.accountType || "通用";
    const normalized = accountType.replace(/\s+/g, "").toLowerCase();
    if (
      normalized.includes(
        "时尚、服装、家居类目白人年轻女性".replace(/\s+/g, "").toLowerCase()
      )
    ) {
      accountType = this.inferDynamicAccountType(productInfo, campaignInfo);
    }
    return { accountType };
  }

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
}