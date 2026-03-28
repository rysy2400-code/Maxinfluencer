// 子 Agent 1: 确认产品信息 Agent
import { BaseAgent } from "./base-agent.js";
import { scrapeProductInfo } from "../tools/web-scraper.js";
import { callDeepSeekLLM } from "../utils/llm-client.js";

export class ProductInfoAgent extends BaseAgent {
  constructor() {
    const systemPrompt = `你是产品信息确认专家。你的任务是基于客户提供的产品链接，提取并确认产品基本信息。

产品基本信息包括：
- 产品链接
- 品牌名
- 产品名
- 产品图片（URL）
- 产品类型（电商、游戏、应用三选一）
- 是否寄样

工作流程：
1. 如果客户提供了产品链接，你需要调用联网搜索工具爬取产品信息
2. 提取关键信息并整理成结构化格式
3. 与客户确认信息的准确性

回复要专业、清晰，用中文与客户沟通。`;

    super("ProductInfoAgent", systemPrompt);
  }

  /**
   * 处理产品信息提取请求
   * @param {Array} messages - 消息历史
   * @param {Object} options - 选项 { productLink: string }
   * @returns {Promise<Object>} - { reply: string, productInfo: Object, isConfirmed: boolean }
   */
  async extractProductInfo(messages, options = {}) {
    const { productLink } = options;

    if (!productLink) {
      return {
        reply: "抱歉，我没有收到产品链接。请提供完整的产品链接（URL）。",
        productInfo: null,
        isConfirmed: false,
      };
    }

    try {
      // 使用联网搜索工具爬取产品信息
      console.log(`[ProductInfoAgent] 开始提取产品信息: ${productLink}`);

      // LLM 提取函数（用于从 HTML 中提取结构化信息）
      const llmExtract = async (prompt) => {
        return await callDeepSeekLLM([{ role: "user", content: prompt }], 
          "你是一个信息提取专家，擅长从网页内容中提取结构化产品信息。只返回 JSON 格式，不要其他文字。");
      };

      let productInfo = await scrapeProductInfo(productLink, llmExtract);

      // 生成确认回复（产品图片使用特殊标记，前端会渲染为图片）
      const confirmationMessage = `我已经提取到以下产品信息，请确认是否正确：

**产品链接**: ${productInfo.productLink}
**品牌名**: ${productInfo.brandName || "未识别"}
**产品名**: ${productInfo.productName || "未识别"}
${productInfo.productImage ? `**产品图片**: [IMAGE:${productInfo.productImage}]` : ""}
**产品类型**: ${productInfo.productType || "未识别"}
**是否寄样**: ${productInfo.needSample ? "是" : "否"}

如需调整请告诉我；确认无误后我们进入下一阶段。`;

      // 判断用户是否确认产品信息，并在需要时根据用户输入更新产品信息
      const detectResult = await this.detectConfirmation(messages, { productInfo });
      if (detectResult && detectResult.productInfo) {
        productInfo = detectResult.productInfo;
      }
      const isConfirmed = detectResult ? detectResult.confirmed === true : false;

      return {
        reply: confirmationMessage,
        productInfo,
        isConfirmed,
      };
    } catch (error) {
      console.error("[ProductInfoAgent] 提取产品信息失败:", error);
      
      // 降级：返回错误信息，但不阻止流程
      return {
        reply: `抱歉，提取产品信息时遇到问题：${error.message}。\n\n你可以手动告诉我产品信息，或者稍后重试。`,
        productInfo: {
          productLink: productLink,
          brandName: "未知",
          productName: "未知",
          productImage: "",
          productType: "未知",
          needSample: false,
        },
        isConfirmed: false,
      };
    }
  }

  /**
   * 确认产品信息（当产品信息已存在时调用）
   * @param {Array} messages - 消息历史
   * @param {Object} context - 上下文（包含 productInfo）
   * @returns {Promise<Object>} - { reply: string, productInfo: Object, isConfirmed: boolean }
   */
  async confirmProductInfo(messages, context = {}) {
    let productInfo = context.productInfo;
    
    if (!productInfo) {
      return {
        reply: "抱歉，我没有找到产品信息。请先提供产品链接。",
        productInfo: null,
        isConfirmed: false,
      };
    }

    // 判断用户是否确认产品信息，同时允许根据用户输入更新产品信息
    const detectResult = await this.detectConfirmation(messages, { productInfo });
    if (detectResult && detectResult.productInfo) {
      productInfo = detectResult.productInfo;
    }
    const isConfirmed = detectResult ? detectResult.confirmed === true : false;

    if (isConfirmed) {
      return {
        reply: "好的，产品信息已确认。让我们继续下一步，请告诉我你的 Campaign 信息（平台、地区、发布时间段、预算、佣金）。",
        productInfo,
        isConfirmed: true,
      };
    } else {
      // 重新显示产品信息让用户确认
      const confirmationMessage = `请确认以下产品信息是否正确：

**产品链接**: ${productInfo.productLink}
**品牌名**: ${productInfo.brandName || "未识别"}
**产品名**: ${productInfo.productName || "未识别"}
${productInfo.productImage ? `**产品图片**: [IMAGE:${productInfo.productImage}]` : ""}
**产品类型**: ${productInfo.productType || "未识别"}
**是否寄样**: ${productInfo.needSample ? "是" : "否"}

如需调整请告诉我；确认无误后我们进入下一阶段。`;

      return {
        reply: confirmationMessage,
        productInfo,
        isConfirmed: false,
      };
    }
  }

  /**
   * 检测用户是否确认产品信息，并在需要时更新产品信息
   * @param {Array} messages - 消息历史
   * @param {Object} context - 上下文（包含 productInfo）
   * @returns {Promise<{ confirmed: boolean, productInfo: Object }>} - 是否确认及（可能被更新的）产品信息
   */
  async detectConfirmation(messages, context = {}) {
    const lastMessage = messages[messages.length - 1]?.content || "";
    const productInfo = context.productInfo;
    const conversationHistory = messages.slice(-3).map(m => `${m.role}: ${m.content}`).join("\n");

    // 如果没有产品信息，不需要判断确认
    if (!productInfo || !productInfo.productLink) {
      return false;
    }

    const prompt = `判断用户是否确认了产品信息，并在需要时更新产品信息。

对话历史：
${conversationHistory}

当前产品信息（JSON）：
${JSON.stringify(productInfo, null, 2)}

你的任务：
1. 根据对话内容，判断用户是否「已经确认」当前产品信息。
2. 如果用户在对话中明确提出了修改（例如“品牌名是 XXX”、“这个不是我们的产品名，应该叫 XXX”、“这是 App 不是电商”、“不需要寄样”等），请在返回的 productInfo 中直接应用这些修改。
3. 如果用户只是提出问题、表达疑惑或还在讨论，不要把 confirmed 设为 true。
4. 如果用户没有提到任何需要修改的点，就保持 productInfo 不变。

判定规则：
- 如果用户确认产品信息（如"确认"、"正确"、"无误"、"可以"、"好的"、"行"、"没问题"、"继续"、"下一步"等），confirmed 设为 true。
- 如果用户要求修改或指出错误，但没有明确说「确认好了」，confirmed 设为 false，同时根据用户的描述更新 productInfo。
- 如果消息不明确或只是询问，confirmed 设为 false，productInfo 只在你非常确定用户提供的是新的正确信息时才更新。

只返回 JSON 格式，不要任何解释文字：
{
  "confirmed": true | false,
  "productInfo": {
    "productLink": string,
    "brandName": string,
    "productName": string,
    "productImage": string,
    "productType": string,
    "needSample": boolean
  }
}`;

    try {
      const llmResponse = await callDeepSeekLLM(
        [{ role: "user", content: prompt }],
        "你是一个意图识别专家，擅长判断用户是否确认信息。只返回 JSON 格式，不要其他文字。"
      );

      try {
        const result = JSON.parse(llmResponse);
        return {
          confirmed: result.confirmed === true,
          productInfo: result.productInfo && typeof result.productInfo === "object" ? result.productInfo : productInfo,
        };
      } catch (e) {
        const jsonMatch = llmResponse.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          const result = JSON.parse(jsonMatch[0]);
          return {
            confirmed: result.confirmed === true,
            productInfo: result.productInfo && typeof result.productInfo === "object" ? result.productInfo : productInfo,
          };
        }
        return { confirmed: false, productInfo };
      }
    } catch (error) {
      console.warn("[ProductInfoAgent] 判断确认失败:", error);
      return { confirmed: false, productInfo };
    }
  }
}