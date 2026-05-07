/**
 * 一次性补齐 influencer_snapshot 中的 analysisSummary、matchAnalysis，
 * 与 upsertCandidatesForCampaign 写入的 snapshot 结构对齐（字符串 + 对象）。
 *
 * 1) tiktok_campaign_influencer_candidates：从 analysis_summary、match_analysis 列合并进 JSON
 * 2) tiktok_campaign_execution：关联候选行，对所有 stage 补齐缺失键（优先用候选表已更新后的 snapshot，再回落到列）
 *
 * 用法：node scripts/migrate-backfill-snapshot-analysis-fields.mjs
 */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import { queryTikTok } from "../lib/db/mysql-tiktok.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
dotenv.config({ path: path.join(projectRoot, ".env") });
dotenv.config({ path: path.join(projectRoot, ".env.local") });

function parseJson(value) {
  if (value == null) return null;
  if (typeof value === "object") return value;
  if (typeof value !== "string") return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function isEmptySummary(v) {
  if (v == null) return true;
  if (typeof v !== "string") return true;
  return v.trim() === "";
}

function hasUsableMatchAnalysis(obj) {
  if (obj == null) return false;
  if (typeof obj !== "object" || Array.isArray(obj)) return false;
  if (Object.keys(obj).length === 0) return false;
  if (obj.analysis != null && String(obj.analysis).trim() !== "") return true;
  if (typeof obj.version === "number") return true;
  if (obj.score != null) return true;
  if (typeof obj.isRecommended === "boolean") return true;
  return false;
}

function parseMatchAnalysisFromColumn(raw) {
  if (raw == null) return null;
  if (typeof raw === "object" && !Array.isArray(raw)) return raw;
  if (typeof raw === "string" && raw.trim()) {
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }
  return null;
}

function mergeSnapshotFromColumns(snap, analysisSummaryCol, matchAnalysisCol) {
  const out = snap && typeof snap === "object" && !Array.isArray(snap) ? { ...snap } : {};
  let changed = false;

  if (isEmptySummary(out.analysisSummary) && analysisSummaryCol != null) {
    const s = String(analysisSummaryCol).trim();
    if (s) {
      out.analysisSummary = s;
      changed = true;
    }
  }

  if (!hasUsableMatchAnalysis(out.matchAnalysis)) {
    const ma = parseMatchAnalysisFromColumn(matchAnalysisCol);
    if (ma && typeof ma === "object") {
      out.matchAnalysis = ma;
      changed = true;
    }
  }

  return { out, changed };
}

async function main() {
  console.log("[backfill] Step 1: tiktok_campaign_influencer_candidates …");
  const candRows = await queryTikTok(
    `
    SELECT id, influencer_snapshot, analysis_summary, match_analysis
    FROM tiktok_campaign_influencer_candidates
  `,
    []
  );
  let candUpdated = 0;
  for (const row of candRows || []) {
    const snap = parseJson(row.influencer_snapshot) || {};
    const { out, changed } = mergeSnapshotFromColumns(
      snap,
      row.analysis_summary,
      row.match_analysis
    );
    if (!changed) continue;
    await queryTikTok(
      `UPDATE tiktok_campaign_influencer_candidates SET influencer_snapshot = ?, updated_at = NOW() WHERE id = ?`,
      [JSON.stringify(out), row.id]
    );
    candUpdated += 1;
  }
  console.log(`[backfill] candidates 扫描 ${(candRows || []).length} 行，更新 ${candUpdated} 行。`);

  console.log("[backfill] Step 2: tiktok_campaign_execution（全 stage，JOIN 候选）…");
  const execRows = await queryTikTok(
    `
    SELECT
      e.id,
      e.influencer_snapshot,
      c.influencer_snapshot AS cand_snapshot,
      c.analysis_summary,
      c.match_analysis
    FROM tiktok_campaign_execution e
    INNER JOIN tiktok_campaign_influencer_candidates c
      ON c.campaign_id = e.campaign_id AND c.tiktok_username = e.tiktok_username
  `,
    []
  );
  let execUpdated = 0;
  let execSkipped = 0;
  for (const row of execRows || []) {
    const execSnap = parseJson(row.influencer_snapshot) || {};
    const candSnap = parseJson(row.cand_snapshot) || {};
    const merged = { ...execSnap };
    let changed = false;

    if (isEmptySummary(merged.analysisSummary)) {
      if (!isEmptySummary(candSnap.analysisSummary)) {
        merged.analysisSummary = candSnap.analysisSummary;
        changed = true;
      } else if (row.analysis_summary != null && String(row.analysis_summary).trim()) {
        merged.analysisSummary = String(row.analysis_summary).trim();
        changed = true;
      }
    }

    if (!hasUsableMatchAnalysis(merged.matchAnalysis)) {
      if (hasUsableMatchAnalysis(candSnap.matchAnalysis)) {
        merged.matchAnalysis = candSnap.matchAnalysis;
        changed = true;
      } else {
        const ma = parseMatchAnalysisFromColumn(row.match_analysis);
        if (ma) {
          merged.matchAnalysis = ma;
          changed = true;
        }
      }
    }

    if (!changed) {
      execSkipped += 1;
      continue;
    }
    await queryTikTok(
      `UPDATE tiktok_campaign_execution SET influencer_snapshot = ?, updated_at = NOW() WHERE id = ?`,
      [JSON.stringify(merged), row.id]
    );
    execUpdated += 1;
  }

  const execNoJoin = await queryTikTok(
    `
    SELECT COUNT(*) AS n
    FROM tiktok_campaign_execution e
    WHERE NOT EXISTS (
      SELECT 1 FROM tiktok_campaign_influencer_candidates c
      WHERE c.campaign_id = e.campaign_id AND c.tiktok_username = e.tiktok_username
    )
  `,
    []
  );
  const orphan = execNoJoin?.[0]?.n ?? 0;

  console.log(`[backfill] execution 可关联行 ${(execRows || []).length}，更新 ${execUpdated}，无需变更 ${execSkipped}。`);
  console.log(`[backfill] execution 无对应候选行（未补齐）: ${orphan} 条。`);
  console.log("[backfill] ✅ 完成。");
}

main().catch((err) => {
  console.error("[backfill] 失败:", err?.message || err);
  process.exit(1);
});
