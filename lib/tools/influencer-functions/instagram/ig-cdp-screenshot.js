/**
 * Instagram CDP 工作实况截图（对齐 TikTok reportScreenshot 事件格式）
 */

/**
 * @param {Function|null} onStepUpdate
 * @param {string} stepId
 * @param {string} label
 * @param {import('playwright').Page} page
 */
export async function reportIgScreenshot(onStepUpdate, stepId, label, page) {
  if (!onStepUpdate || !page) return;
  try {
    if (typeof page.isClosed === "function" && page.isClosed()) return;
    const screenshot = await Promise.race([
      page.screenshot({ type: "jpeg", quality: 55, fullPage: false }),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("截图超时（20秒）")), 20000)
      ),
    ]);
    let pageUrl = "";
    try {
      pageUrl = page.url() || "";
    } catch {
      /* ignore */
    }
    const browseLabel =
      pageUrl && !String(label).includes(pageUrl)
        ? `${label} ${pageUrl}`
        : label;
    onStepUpdate({
      type: "screenshot",
      stepId,
      label: browseLabel,
      image: `data:image/jpeg;base64,${screenshot.toString("base64")}`,
      timestamp: new Date().toISOString(),
    });
  } catch (e) {
    console.warn(`[ig-cdp-screenshot] ${label}: ${e?.message || e}`);
  }
}
