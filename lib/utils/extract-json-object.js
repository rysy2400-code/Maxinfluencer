/**
 * 从 LLM 返回文本里提取**第一个完整且括号平衡的 JSON 对象**。
 *
 * 为什么不用 `/\{[\s\S]*\}/`：该正则贪婪匹配到最后一个 `}`，当模型把同一个 JSON
 * 输出两遍（或正文后面又跟一段示例 JSON）时，会把两段一起截下来，
 * `JSON.parse` 直接抛 `Unexpected non-whitespace character after JSON`。
 * 这里改为从第一个 `{` 开始做括号配对，只取第一个能解析成功的对象。
 *
 * 兼容：前后夹带说明文字、```json 代码块、字符串内部含 `{` `}` 与转义字符。
 *
 * @param {unknown} text
 * @returns {string|null} 第一个可解析的 JSON 对象文本；找不到返回 null
 */
export function extractFirstJsonObject(text) {
  const s = String(text ?? "");
  for (let start = s.indexOf("{"); start !== -1; start = s.indexOf("{", start + 1)) {
    const end = findBalancedObjectEnd(s, start);
    if (end === -1) continue;
    const candidate = s.slice(start, end + 1);
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return candidate;
      }
    } catch {
      /* 不是合法 JSON，继续找下一个 { */
    }
  }
  return null;
}

/**
 * 从 `start`（必须是 `{`）开始做括号配对，返回配对的 `}` 下标；不平衡返回 -1。
 * 会跳过 JSON 字符串内部的括号，正确处理 `\"` 转义。
 *
 * @param {string} s
 * @param {number} start
 * @returns {number}
 */
function findBalancedObjectEnd(s, start) {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < s.length; i += 1) {
    const ch = s[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return i;
      if (depth < 0) return -1;
    }
  }
  return -1;
}

/**
 * `extractFirstJsonObject` + `JSON.parse` 的便捷封装：解析失败一律返回 fallback，不抛错。
 *
 * @param {unknown} text
 * @param {object} [fallback]
 * @returns {object}
 */
export function parseFirstJsonObject(text, fallback = {}) {
  const json = extractFirstJsonObject(text);
  if (!json) return fallback;
  try {
    const parsed = JSON.parse(json);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed
      : fallback;
  } catch {
    return fallback;
  }
}
