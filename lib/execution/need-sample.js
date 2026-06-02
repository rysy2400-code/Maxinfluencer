/**
 * 判断 campaign 是否需要寄样。
 * 优先读 productInfo.needSample；否则按 productType 兜底（电商 → true，游戏/应用 → false）。
 */
export function resolveNeedSample(productInfo) {
  if (productInfo && typeof productInfo.needSample === "boolean") {
    return productInfo.needSample;
  }
  const productType =
    productInfo && typeof productInfo.productType === "string"
      ? productInfo.productType.trim()
      : "";
  if (productType === "电商") return true;
  if (productType === "游戏" || productType === "应用") return false;
  return true;
}
