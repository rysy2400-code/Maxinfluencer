/**
 * 导入名单按平台拆分：
 * 提交时将混合名单拆成平台子任务（youtube / tiktok / instagram），
 * 由对应平台专属 worker 独立消费；X 与未知平台暂不纳入导入链路。
 */

export const IMPORT_PLATFORM_SLUGS = ["youtube", "tiktok", "instagram"];

export const IMPORT_PLATFORM_LABEL = {
  youtube: "YouTube",
  tiktok: "TikTok",
  instagram: "Instagram",
  x: "X",
};

/**
 * @param {Array<{ platform?: string, platformSlug?: string }>} rows
 * @returns {{ youtube: Array, tiktok: Array, instagram: Array, x: Array, unknown: Array }}
 */
export function splitImportRowsByPlatform(rows = []) {
  const buckets = {
    youtube: [],
    tiktok: [],
    instagram: [],
    x: [],
    unknown: [],
  };
  for (const row of rows || []) {
    const slug = String(row?.platformSlug || row?.platform || "")
      .trim()
      .toLowerCase();
    if (Object.prototype.hasOwnProperty.call(buckets, slug)) {
      buckets[slug].push(row);
    } else {
      buckets.unknown.push(row);
    }
  }
  return buckets;
}

export function platformLabel(slug) {
  return IMPORT_PLATFORM_LABEL[String(slug || "").toLowerCase()] || String(slug || "未知");
}

/**
 * 平台子任务 import_batch_id 后缀（保证同批次内唯一，payload.importBatchId 保留公共批次号）
 * @param {string} baseBatchId
 * @param {string} platformSlug
 */
export function platformSubtaskBatchId(baseBatchId, platformSlug) {
  return `${baseBatchId}-${String(platformSlug).toLowerCase()}`;
}
