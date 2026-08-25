/**
 * 全局红人触达排除名单（do-not-contact）
 *
 * 用户导入「仅排重/不联系」名单时：
 * 1. 写入全局表 tiktok_influencer_contact_exclusion（所有 campaign 生效）；
 * 2. 仅插入本 campaign 候选表中尚不存在的行（do_not_contact=1），已有行不做任何修改。
 *
 * 排除名单在三个环节强制生效：
 * - 搜索/导入 enrich 前跳过（见 search-and-extract-influencers.js / process-import-task.js）；
 * - 候选表 upsert 时写回 do_not_contact=1 且 should_contact 强制 0（见 campaign-candidates-dao.js）；
 * - 执行挑选时过滤（见 pickCandidatesForExecution）。
 */
import { queryTikTok } from "./mysql-tiktok.js";
import { normalizePlatformSlugInput } from "../influencer/parse-profile-url.js";

export const EXCLUSION_SOURCE = "user_exclude";

export function normalizeExclusionHandle(raw) {
  return String(raw || "")
    .replace(/^@+/, "")
    .trim()
    .toLowerCase();
}

export function exclusionKey(platformSlug, handle) {
  const slug = normalizePlatformSlugInput(platformSlug) || String(platformSlug || "").toLowerCase();
  const h = normalizeExclusionHandle(handle);
  return `${slug}:${h}`;
}

function buildExclusionSnapshot(row, batchId, sourceFile) {
  return {
    username: row.username || null,
    displayName: row.displayName || row.username || null,
    profileUrl: row.profileUrl || null,
    platform: row.platform || null,
    excluded: true,
    exclusionSourceFile: sourceFile || null,
    exclusionBatchId: batchId || null,
    exclusionImportedAt: new Date().toISOString(),
  };
}

/**
 * 加载全局排除名单。
 * @returns {Promise<{ keyed: Set<string>, handles: Set<string> }>}
 *   keyed = `${platformSlug}:${handle}`；handles = 全部 handle（供平台未知时兜底）
 */
export async function loadGlobalContactExclusionMaps() {
  const rows = await queryTikTok(
    `
    SELECT platform, handle
    FROM tiktok_influencer_contact_exclusion
  `,
    []
  );
  const keyed = new Set();
  const handles = new Set();
  for (const r of rows || []) {
    const slug = normalizePlatformSlugInput(r.platform) || String(r.platform || "").toLowerCase();
    const h = normalizeExclusionHandle(r.handle);
    if (!h) continue;
    handles.add(h);
    if (slug) keyed.add(`${slug}:${h}`);
  }
  return { keyed, handles };
}

/**
 * 本 campaign 候选表中已标记 do_not_contact=1 的 handle 集合
 */
export async function loadCampaignDoNotContactSet(campaignId) {
  if (!campaignId) return new Set();
  const rows = await queryTikTok(
    `
    SELECT LOWER(tiktok_username) AS u
    FROM tiktok_campaign_influencer_candidates
    WHERE campaign_id = ? AND do_not_contact = 1
  `,
    [campaignId]
  );
  return new Set(
    (rows || []).map((r) => String(r.u || "").trim()).filter(Boolean)
  );
}

/**
 * @param {{ keyed: Set<string>, handles: Set<string> }} maps
 * @param {string|null|undefined} platformSlug
 * @param {string} handle
 * @returns {boolean}
 */
export function isHandleExcluded(maps, platformSlug, handle) {
  const h = normalizeExclusionHandle(handle);
  if (!h) return false;
  const slug = normalizePlatformSlugInput(platformSlug);
  if (slug && maps?.keyed?.has(`${slug}:${h}`)) return true;
  if (!slug && maps?.handles?.has(h)) return true;
  return false;
}

/**
 * 把名单行按排除名单过滤：返回 { kept, excluded }
 * @param {Array<{ username?: string, platformSlug?: string, platform?: string }>} rows
 * @param {{ keyed: Set<string>, handles: Set<string> }} maps
 */
export function filterRowsAgainstExclusion(rows, maps) {
  const kept = [];
  const excluded = [];
  for (const row of rows || []) {
    const slug = normalizePlatformSlugInput(row?.platformSlug || row?.platform);
    if (isHandleExcluded(maps, slug, row?.username)) {
      excluded.push(row);
    } else {
      kept.push(row);
    }
  }
  return { kept, excluded };
}

/**
 * 应用「仅排重/不联系」名单：
 * - 全局表 upsert（新增 + 补全 profile_url/来源信息）；
 * - 本 campaign 候选表仅插入不存在的行（do_not_contact=1），已有行不改动。
 *
 * @param {{
 *   campaignId: string,
 *   rows: Array<{ profileUrl?: string, username?: string, displayName?: string, platformSlug?: string, platform?: string }>,
 *   batchId?: string,
 *   sourceFile?: string,
 * }} input
 */
export async function applyContactExclusions({
  campaignId,
  rows = [],
  batchId = null,
  sourceFile = null,
}) {
  const out = {
    totalUnique: 0,
    globalInserted: 0,
    globalAlreadyExists: 0,
    candidateInserted: 0,
    candidateAlreadyExists: 0,
    skippedInvalid: 0,
    platforms: {},
  };
  if (!campaignId || !Array.isArray(rows) || !rows.length) return out;

  // 规范化 + 按 (platform, handle) 去重
  const unique = new Map();
  for (const row of rows) {
    const handle = normalizeExclusionHandle(row.username);
    const slug = normalizePlatformSlugInput(row.platformSlug || row.platform);
    if (!handle || !slug) {
      out.skippedInvalid += 1;
      continue;
    }
    const key = `${slug}:${handle}`;
    if (!unique.has(key)) {
      unique.set(key, {
        username: row.username || handle,
        displayName: row.displayName || null,
        profileUrl: String(row.profileUrl || "").trim() || null,
        platformSlug: slug,
        platform: row.platform || null,
      });
      out.platforms[slug] = (out.platforms[slug] || 0) + 1;
    }
  }
  out.totalUnique = unique.size;
  if (!unique.size) return out;

  const list = [...unique.values()];

  // ---- 全局表 ----
  const existingRows = await queryTikTok(
    `
    SELECT platform, handle
    FROM tiktok_influencer_contact_exclusion
  `,
    []
  );
  const existingKeys = new Set(
    (existingRows || []).map((r) => {
      const slug = normalizePlatformSlugInput(r.platform) || String(r.platform || "").toLowerCase();
      return `${slug}:${normalizeExclusionHandle(r.handle)}`;
    })
  );

  const CHUNK = 500;
  for (let i = 0; i < list.length; i += CHUNK) {
    const chunk = list.slice(i, i + CHUNK);
    const placeholders = chunk.map(() => "(?,?,?,?,?,?)").join(",");
    const values = [];
    for (const r of chunk) {
      values.push(
        r.platformSlug,
        normalizeExclusionHandle(r.username),
        r.profileUrl,
        r.displayName,
        sourceFile,
        batchId
      );
    }
    const result = await queryTikTok(
      `
      INSERT INTO tiktok_influencer_contact_exclusion (
        platform, handle, profile_url, display_name, source_file, source_batch_id
      ) VALUES ${placeholders}
      ON DUPLICATE KEY UPDATE
        profile_url = IF(
          VALUES(profile_url) IS NOT NULL AND VALUES(profile_url) <> '',
          VALUES(profile_url),
          tiktok_influencer_contact_exclusion.profile_url
        ),
        display_name = IF(
          VALUES(display_name) IS NOT NULL AND VALUES(display_name) <> '',
          VALUES(display_name),
          tiktok_influencer_contact_exclusion.display_name
        ),
        source_file = VALUES(source_file),
        source_batch_id = VALUES(source_batch_id)
    `,
      values
    );
    const affected = Number(result?.affectedRows || 0);
    // 本 chunk 新增行数 = affected - 更新行数；更新行数 ≈ chunk 中已存在键数
    const chunkExisting = chunk.filter((r) =>
      existingKeys.has(`${r.platformSlug}:${normalizeExclusionHandle(r.username)}`)
    ).length;
    out.globalInserted += Math.max(0, chunk.length - chunkExisting);
    out.globalAlreadyExists += chunkExisting;
  }

  // ---- 本 campaign 候选表（仅插入新行）----
  const candRows = await queryTikTok(
    `
    SELECT LOWER(tiktok_username) AS u
    FROM tiktok_campaign_influencer_candidates
    WHERE campaign_id = ?
  `,
    [campaignId]
  );
  const candSet = new Set(
    (candRows || []).map((r) => String(r.u || "").trim()).filter(Boolean)
  );
  const toInsert = list.filter(
    (r) => !candSet.has(normalizeExclusionHandle(r.username))
  );
  out.candidateAlreadyExists = list.length - toInsert.length;

  const nowIso = new Date().toISOString();
  for (let i = 0; i < toInsert.length; i += CHUNK) {
    const chunk = toInsert.slice(i, i + CHUNK);
    const placeholders = chunk.map(() => "(?,?,?,?,?,?,?)").join(",");
    const values = [];
    for (const r of chunk) {
      values.push(
        campaignId,
        normalizeExclusionHandle(r.username),
        EXCLUSION_SOURCE,
        JSON.stringify(buildExclusionSnapshot(r, batchId, sourceFile)),
        0,
        1,
        "用户导入的不联系名单（排重触达记录）：不分析、不联系"
      );
    }
    const result = await queryTikTok(
      `
      INSERT IGNORE INTO tiktok_campaign_influencer_candidates (
        campaign_id,
        tiktok_username,
        source,
        influencer_snapshot,
        should_contact,
        do_not_contact,
        analysis_summary
      ) VALUES ${placeholders}
    `,
      values
    );
    out.candidateInserted += Number(result?.affectedRows || 0);
  }

  return out;
}

/**
 * 一次性（脚本/手工）应用名单后的摘要文本
 */
export function formatExclusionImportSummary(result) {
  const platText = Object.entries(result.platforms || {})
    .map(([slug, n]) => `${slug} ${n}`)
    .join(" · ");
  return [
    `不联系名单已生效（全局 + 本 campaign）。`,
    `- 识别并去重: ${result.totalUnique} 位${platText ? `（${platText}）` : ""}`,
    `- 全局排除表: 新增 ${result.globalInserted}，已存在 ${result.globalAlreadyExists}`,
    `- 本 campaign 候选表: 新增标记 ${result.candidateInserted}，已有候选行未改动 ${result.candidateAlreadyExists}`,
    result.skippedInvalid > 0 ? `- 无法解析跳过: ${result.skippedInvalid} 条` : null,
  ]
    .filter(Boolean)
    .join("\n");
}
