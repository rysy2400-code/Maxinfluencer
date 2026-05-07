/**
 * 展示用：去掉模型在分析正文里常见的「JSON 输出」元章节与空代码块占位，
 * 避免前端 Markdown 渲染出「JSON 输出」标题或空白灰框。
 *
 * @param {string} md
 * @returns {string}
 */
export function sanitizeAnalysisMarkdownForDisplay(md) {
  if (md == null || typeof md !== "string") return "";
  let s = md.replace(/\r\n/g, "\n");

  // 去掉仅作结构说明、对用户无价值的标题行（含「最终结论与 JSON输出」等；\b 对中英文边界不稳，用子串 JSON）
  const headingNoise = /(?:^|\n)\s*#{1,6}\s*[^\n]*JSON[^\n]*\s*/gi;
  const plainJsonLabel = /(?:^|\n)\s*JSON\s*输出\s*(?=\n|$)/gi;
  for (let i = 0; i < 8; i++) {
    const next = s.replace(headingNoise, "\n").replace(plainJsonLabel, "\n");
    if (next === s) break;
    s = next;
  }

  // 去掉正文中「空」fenced 块（仅空白/换行，含 ```json、``` 或带语言标签）
  const emptyFence =
    /(?:^|\n)\s*```(?:json|[a-z0-9_-]+)?\s*[\n\r\t ]*\n?\s*```\s*(?=\n|$)/gi;
  for (let i = 0; i < 12; i++) {
    const next = s.replace(emptyFence, "\n");
    if (next === s) break;
    s = next;
  }

  s = s.replace(/\n{3,}/g, "\n\n").trim();
  return s;
}
