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

  // 去掉 (2) 机器可读结果 及其后全部内容（结论/匹配度由 UI 顶栏与底部字段展示）
  s = s.replace(
    /(?:^|\n)\s*(?:#{1,6}\s*)?[（(]?\s*2\s*[）)]?\s*[、.:：]?\s*机器可读[^\n]*[\s\S]*$/iu,
    ""
  );

  // 去掉 (1) 分析正文 标题行
  s = s.replace(
    /(?:^|\n)\s*(?:#{1,6}\s*)?[（(]?\s*1\s*[）)]?\s*[、.:：]?\s*分析正文\s*\n?/giu,
    "\n"
  );

  // 去掉开场白：截断到首个「基础数据评估」小节
  const firstSectionIdx = s.search(/(?:^|\n)\s*(?:#{1,6}\s*)?基础数据评估\b/m);
  if (firstSectionIdx > 0) {
    s = s.slice(firstSectionIdx).replace(/^\s*\n+/, "");
  }

  // 兜底：常见自我介绍整段
  s = s.replace(
    /^好的[，,][^\n]*(?:\n|$)+/u,
    ""
  );
  s = s.replace(
    /^(?:作为[^。\n]{0,60}分析师[^。\n]{0,160}[。.]\n*|我将对[^。\n]{0,120}的数据进行分析[^。\n]*[。.]\n*|我将对[^。\n]{0,120}进行分析[。.]\n*|作为一名专业的红人营销分析师[，,][^\n]*\n+)/u,
    ""
  );

  // 去掉 echo 出来的 prompt 结构标签行
  s = s.replace(
    /(?:^|\n)\s*(?:#{1,6}\s*)?[（(]?\s*[12]\s*[）)]?\s*[、.:：]?\s*(?:分析正文|机器可读结果)[^\n]*\n/giu,
    "\n"
  );

  // 去掉正文里残留的 ```json … ``` 块（机器可读结果不应出现在 Markdown 区）
  s = s.replace(/```json[\s\S]*?```/gi, "\n");
  s = s.replace(/```json[\s\S]*$/i, "");

  // 去掉正文中误写的「推荐理由」节（理由应只在 JSON reason 字段）
  s = s.replace(/(?:^|\n)\s*#{1,6}\s*推荐理由\s*\n[\s\S]*?(?=\n#{1,6}\s|$)/gi, "\n");

  // 去掉第四节末「结论：推荐/不推荐」类收束句（结论由 JSON / 顶栏展示）
  s = s.replace(/(?:^|\n)\s*\*{0,2}结论\s*[：:]\s*(?:推荐|不推荐)[^\n]*\n?/gi, "\n");

  // 去掉正文末尾「综上所述…」类总括（与 UI 结论重复）
  s = s.replace(/(?:^|\n)\s*综上所述[，,][^\n]*(?:\n(?!\s*(?:#{1,6}\s*)?(?:基础|账户|内容|与产品))[^\n]*)*$/u, "\n");

  // 去掉仅作结构说明、对用户无价值的标题行（含「最终结论与 JSON输出」等）
  const headingNoise = /(?:^|\n)\s*#{1,6}\s*[^\n]*JSON[^\n]*\s*/gi;
  const plainJsonLabel = /(?:^|\n)\s*JSON\s*输出\s*(?=\n|$)/gi;
  for (let i = 0; i < 8; i++) {
    const next = s.replace(headingNoise, "\n").replace(plainJsonLabel, "\n");
    if (next === s) break;
    s = next;
  }

  // 去掉正文中「空」fenced 块
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
