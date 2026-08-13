// DeepSeek LLM 客户端封装
// @param {Array} messages - 消息列表
// @param {string|null} systemPrompt - 系统提示
// @param {Object} options - 可选参数 { maxTokens: number, timeoutMs: number }
//   timeoutMs 默认 120000ms（可用 DEEPSEEK_LLM_TIMEOUT_MS 调整）；传 0 表示不超时
// @returns {Promise<string|Object>} - 默认返回 content 字符串；若 options.returnFullResponse=true 则返回完整响应
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// LLM 默认超时兜底：调用方未显式传 timeoutMs 时使用，避免网络/流挂死后 Promise 永不结束。
// 显式传 timeoutMs: 0 仍表示“不超时”，供确有需要的长任务显式选择。
// 非流式单次生成默认 120s；流式长内容（脚本/分析/调度器进度流）默认 180s。
const DEFAULT_LLM_TIMEOUT_MS = Math.max(
  30_000,
  Number(process.env.DEEPSEEK_LLM_TIMEOUT_MS || 120_000) || 120_000
);
const DEFAULT_LLM_STREAM_TIMEOUT_MS = Math.max(
  60_000,
  Number(process.env.DEEPSEEK_LLM_STREAM_TIMEOUT_MS || 180_000) || 180_000
);

/** DeepSeek 报错落盘（worker 常驻进程无终端输出时仍可排查） */
function logDeepSeekError(status, errorText) {
  try {
    const file = path.resolve(__dirname, "../../logs/deepseek-errors.log");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const line =
      `[${new Date().toISOString()}] HTTP ${status} ` +
      String(errorText || "").slice(0, 2000).replace(/\s+/g, " ") +
      "\n";
    fs.appendFileSync(file, line, "utf-8");
  } catch {
    /* 日志失败不影响主流程 */
  }
}

export async function callDeepSeekLLM(messages, systemPrompt = null, options = {}) {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  const apiUrl = process.env.DEEPSEEK_API_URL || "https://api.deepseek.com/v1/chat/completions";
  const model = process.env.DEEPSEEK_MODEL || "deepseek-v4-flash";
  const { maxTokens = 8192, returnFullResponse = false, timeoutMs = DEFAULT_LLM_TIMEOUT_MS } = options;

  if (!apiKey) {
    throw new Error("DEEPSEEK_API_KEY 未配置");
  }

  let abortTimer = null;
  const controller = timeoutMs > 0 ? new AbortController() : null;
  if (controller) {
    abortTimer = setTimeout(() => controller.abort(), timeoutMs);
  }

  // 构建消息列表
  const payloadMessages = [];
  if (systemPrompt) {
    payloadMessages.push({ role: "system", content: systemPrompt });
  }
  payloadMessages.push(...messages.map((m) => ({
    role: m.role === "assistant" ? "assistant" : "user",
    content: m.content,
  })));

  try {
    const response = await fetch(apiUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      signal: controller?.signal,
      body: JSON.stringify({
        model,
        messages: payloadMessages,
        temperature: 0.7,
        max_tokens: maxTokens, // 增加输出 token 限制，避免截断（默认 8192，可设为 32768）
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error("DeepSeek API error:", errorText);
      logDeepSeekError(response.status, errorText);
      throw new Error(`DeepSeek API 请求失败: ${response.status}`);
    }

    const data = await response.json();
    const choice = data.choices?.[0];
    const content = choice?.message?.content || "抱歉，我暂时无法回复。";
    const finishReason = choice?.finish_reason || "unknown";
    const usage = data.usage || {};

    if (returnFullResponse) {
      return { content, finishReason, usage, raw: data };
    }
    return content;
  } catch (error) {
    if (error?.name === "AbortError" && timeoutMs > 0) {
      const err = new Error(`DeepSeek API 请求超时（${timeoutMs}ms）`);
      err.cause = error;
      console.error("DeepSeek 调用异常:", err.message);
      throw err;
    }
    console.error("DeepSeek 调用异常:", error);
    throw error;
  } finally {
    if (abortTimer) clearTimeout(abortTimer);
  }
}

/**
 * 流式调用 DeepSeek LLM
 * @param {Array} messages - 消息列表
 * @param {string|null} systemPrompt - 系统提示
 * @param {Function} onChunk - 每次收到数据块时的回调函数 (chunk: string) => void
 * @param {Object} options - 可选参数 { maxTokens: number, timeoutMs: number }
 *   timeoutMs 默认 180000ms（可用 DEEPSEEK_LLM_STREAM_TIMEOUT_MS 调整）；传 0 表示不超时
 * @returns {Promise<string>} - 完整的响应内容
 */
export async function callDeepSeekLLMStream(messages, systemPrompt = null, onChunk = null, options = {}) {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  const apiUrl = process.env.DEEPSEEK_API_URL || "https://api.deepseek.com/v1/chat/completions";
  const model = process.env.DEEPSEEK_MODEL || "deepseek-v4-flash";
  const { maxTokens = 8192, timeoutMs = DEFAULT_LLM_STREAM_TIMEOUT_MS } = options;

  if (!apiKey) {
    throw new Error("DEEPSEEK_API_KEY 未配置");
  }

  let abortTimer = null;
  const controller = timeoutMs > 0 ? new AbortController() : null;
  if (controller) {
    abortTimer = setTimeout(() => controller.abort(), timeoutMs);
  }

  // 构建消息列表
  const payloadMessages = [];
  if (systemPrompt) {
    payloadMessages.push({ role: "system", content: systemPrompt });
  }
  payloadMessages.push(...messages.map((m) => ({
    role: m.role === "assistant" ? "assistant" : "user",
    content: m.content,
  })));

  let reader = null;
  try {
    const response = await fetch(apiUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      signal: controller?.signal,
      body: JSON.stringify({
        model,
        messages: payloadMessages,
        temperature: 0.7,
        max_tokens: maxTokens,
        stream: true, // 启用流式输出
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error("DeepSeek API error:", errorText);
      logDeepSeekError(response.status, errorText);
      throw new Error(`DeepSeek API 请求失败: ${response.status}`);
    }

    reader = response.body.getReader();
    const decoder = new TextDecoder();
    let fullContent = "";
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || ""; // 保留最后一个不完整的行

      for (const line of lines) {
        if (line.startsWith("data: ")) {
          const data = line.slice(6);
          if (data === "[DONE]") continue;

          try {
            const json = JSON.parse(data);
            const delta = json.choices?.[0]?.delta?.content;
            if (delta) {
              fullContent += delta;
              if (onChunk) {
                onChunk(delta);
              }
            }
          } catch (e) {
            // 忽略解析错误
          }
        }
      }
    }

    // 处理剩余的 buffer
    if (buffer.trim()) {
      const lines = buffer.split("\n");
      for (const line of lines) {
        if (line.startsWith("data: ")) {
          const data = line.slice(6);
          if (data === "[DONE]") continue;

          try {
            const json = JSON.parse(data);
            const delta = json.choices?.[0]?.delta?.content;
            if (delta) {
              fullContent += delta;
              if (onChunk) {
                onChunk(delta);
              }
            }
          } catch (e) {
            // 忽略解析错误
          }
        }
      }
    }

    return fullContent;
  } catch (error) {
    if (error?.name === "AbortError" && timeoutMs > 0) {
      const err = new Error(`DeepSeek 流式请求超时（${timeoutMs}ms）`);
      err.cause = error;
      console.error("DeepSeek 流式调用异常:", err.message);
      throw err;
    }
    console.error("DeepSeek 流式调用异常:", error);
    throw error;
  } finally {
    if (abortTimer) clearTimeout(abortTimer);
    if (reader) {
      try {
        await reader.cancel();
      } catch (_) {
        /* ignore */
      }
    }
  }
}
