// Agent 基类
import { callDeepSeekLLM } from "../utils/llm-client.js";

export class BaseAgent {
  constructor(name, systemPrompt) {
    this.name = name;
    this.systemPrompt = systemPrompt;
  }

  /**
   * 处理消息并返回回复
   * @param {Array} messages - 消息历史 [{role: "user"|"assistant", content: string}]
   * @param {Object} context - 额外上下文（如产品信息、工具结果等）
   * @returns {Promise<string>} - Agent 的回复
   */
  async process(messages, context = {}) {
    // 构建消息列表（不包含 system，会在 callDeepSeekLLM 中添加）
    const processedMessages = messages.map((m) => ({
      role: m.role,
      content: m.content,
    }));

    // 如果有上下文，添加到最后一条消息
    if (Object.keys(context).length > 0) {
      const contextStr = JSON.stringify(context, null, 2);
      if (processedMessages.length > 0) {
        processedMessages[processedMessages.length - 1].content += `\n\n[上下文信息]\n${contextStr}`;
      }
    }

    try {
      // 调用 LLM（传入 system prompt 和消息）
      const reply = await callDeepSeekLLM(processedMessages, this.systemPrompt);
      return reply;
    } catch (error) {
      console.error(`[${this.name}] 处理消息失败:`, error);
      throw error;
    }
  }
}

