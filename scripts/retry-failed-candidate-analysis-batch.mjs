/**
 * 批量重试 running campaign 中分析失败的候选红人。
 * 从 TikTok_influencer 加载 profile_data / search_video_data，用当前 analyzeInfluencerMatch 重分析，
 * 更新候选表；推荐且有邮箱的写入执行表。
 *
 * 用法:
 *   node scripts/retry-failed-candidate-analysis-batch.mjs
 *   node scripts/retry-failed-candidate-analysis-batch.mjs --concurrency=12 --limit=50
 *   node scripts/retry-failed-candidate-analysis-batch.mjs --dry-run
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { queryTikTok } from "../lib/db/mysql-tiktok.js";
import { analyzeInfluencerMatch, isTechnicalAnalysisFailure } from "../lib/tools/influencer-functions/analyze-influencer-match.js";
import {
  buildNormalizedInfluencerSnapshot,
  markCandidatePicked,
  resolvePlatformInfluencerId,
  updateCandidateAfterReanalysis,
} from "../lib/db/campaign-candidates-dao.js";
import { enqueueFirstOutreach } from "../lib/agents/influencer-agent.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");

function parseJson(value) {
  if (value == null) return null;
  if (typeof value === "object") return value;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function parseArgs() {
  const args = process.argv.slice(2);
  const limitArg = args.find((a) => a.startsWith("--limit="));
  const concurrencyArg = args.find((a) => a.startsWith("--concurrency="));
  return {
    dryRun: args.includes("--dry-run"),
    limit: limitArg ? Math.max(1, parseInt(limitArg.split("=")[1], 10) || 0) : 0,
    concurrency: Math.max(
      1,
      Math.min(30, parseInt(concurrencyArg?.split("=")[1] || process.env.RETRY_ANALYSIS_CONCURRENCY || "10", 10) || 10)
    ),
  };
}

function isFailureSummary(summary) {
  const s = String(summary || "").trim();
  if (!s) return true;
  if (s === "无法从响应中提取理由") return true;
  if (s === "分析失败" || s.startsWith("分析失败:")) return true;
  if (s === "未提供理由") return true;
  return false;
}

function buildInfluencerFromRow(row, tiktokRow, globalRow) {
  const snap = parseJson(row.influencer_snapshot) || {};
  const profileData = parseJson(tiktokRow?.profile_data) || {};
  const searchVideoData = parseJson(tiktokRow?.search_video_data);
  const followers = snap.followers || {
    count: tiktokRow?.followers_count ?? 0,
    display: tiktokRow?.followers_display || "0",
  };
  const views = snap.views || {
    avg: tiktokRow?.avg_views ?? 0,
    display: tiktokRow?.views_display || "0",
  };

  return {
    username: row.tiktok_username,
    displayName: snap.displayName || tiktokRow?.display_name || row.tiktok_username,
    profileUrl: snap.profileUrl || tiktokRow?.profile_url || null,
    platform: snap.platform || row.campaign_platform || "TikTok",
    bio: snap.bio || tiktokRow?.bio || profileData?.userInfo?.bio || "",
    verified: snap.verified ?? tiktokRow?.verified ?? profileData?.userInfo?.verified ?? false,
    followers,
    followers_count: followers?.count ?? tiktokRow?.followers_count ?? 0,
    followers_display: followers?.display,
    views,
    avg_views: views?.avg ?? tiktokRow?.avg_views,
    engagement: snap.engagement || {
      avgLikes: tiktokRow?.avg_likes,
      avgComments: tiktokRow?.avg_comments,
    },
    postsCount: snap.postsCount ?? tiktokRow?.posts_count ?? profileData?.userInfo?.postsCount?.count,
    gmv: snap.gmv ?? null,
    gmvDisplay: snap.gmvDisplay ?? null,
    unitsSold: snap.unitsSold ?? null,
    unitsSoldDisplay: snap.unitsSoldDisplay ?? null,
    video_publish_country: snap.videoPublishCountry ?? tiktokRow?.video_publish_country ?? null,
    email:
      snap.email ||
      globalRow?.influencer_email ||
      profileData?.userInfo?.email ||
      null,
    profile_data: profileData,
    search_video_data: Array.isArray(searchVideoData) ? searchVideoData : [],
    tiktokUserId:
      row.influencer_id ||
      profileData?.userInfo?.userId ||
      profileData?.userInfo?.user_id ||
      globalRow?.influencer_id ||
      null,
  };
}

async function fetchFailureRows(limit) {
  const sql = `
    SELECT
      c.id AS candidate_id,
      c.campaign_id,
      c.tiktok_username,
      c.influencer_id,
      c.analysis_summary,
      c.influencer_snapshot,
      c.picked_at,
      camp.platform AS campaign_platform,
      camp.region,
      camp.budget,
      camp.commission,
      camp.product_info,
      camp.campaign_info,
      camp.influencer_profile,
      camp.status AS campaign_status
    FROM tiktok_campaign camp
    JOIN tiktok_campaign_influencer_candidates c ON c.campaign_id = camp.id
    WHERE camp.status = 'running'
      AND c.analyzed_at IS NOT NULL
      AND (
        c.analysis_summary IS NULL OR c.analysis_summary = ''
        OR c.analysis_summary = '无法从响应中提取理由'
        OR c.analysis_summary = '未提供理由'
        OR c.analysis_summary = '分析失败'
        OR c.analysis_summary LIKE '分析失败:%'
      )
    ORDER BY c.analyzed_at DESC
    ${limit > 0 ? `LIMIT ${Number(limit)}` : ""}
  `;
  return queryTikTok(sql);
}

async function loadTikTokInfluencer(username) {
  const u = String(username || "").replace(/^@/, "").trim();
  if (!u) return null;
  const rows = await queryTikTok(
    `SELECT username, display_name, profile_url, bio, verified,
            followers_count, followers_display, avg_views, views_display,
            avg_likes, avg_comments, posts_count, video_publish_country,
            profile_data, search_video_data
     FROM TikTok_influencer WHERE LOWER(username) = LOWER(?) LIMIT 1`,
    [u]
  );
  return rows?.[0] || null;
}

async function loadGlobalInfluencer(username, influencerId) {
  if (influencerId) {
    const byId = await queryTikTok(
      `SELECT influencer_id, username, influencer_email FROM tiktok_influencer WHERE influencer_id = ? LIMIT 1`,
      [String(influencerId)]
    );
    if (byId?.[0]) return byId[0];
  }
  const u = String(username || "").replace(/^@/, "").trim();
  if (!u) return null;
  const rows = await queryTikTok(
    `SELECT influencer_id, username, influencer_email FROM tiktok_influencer WHERE LOWER(username) = LOWER(?) LIMIT 1`,
    [u]
  );
  return rows?.[0] || null;
}

async function tryInsertExecution({ campaignId, tiktokUsername, platformInfluencerId, snapshot, matchScore, dryRun }) {
  const exists = await queryTikTok(
    `SELECT 1 AS ok FROM tiktok_campaign_execution WHERE campaign_id = ? AND tiktok_username = ? LIMIT 1`,
    [campaignId, tiktokUsername]
  );
  if (exists?.length) {
    return { inserted: false, reason: "already_in_execution" };
  }

  if (dryRun) {
    return { inserted: true, reason: "dry_run" };
  }

  const now = new Date();
  const insertResult = await queryTikTok(
    `
    INSERT IGNORE INTO tiktok_campaign_execution (
      campaign_id, tiktok_username, influencer_id, influencer_snapshot, stage, last_event
    ) VALUES (?, ?, ?, ?, 'pending_quote', ?)
  `,
    [
      campaignId,
      tiktokUsername,
      platformInfluencerId,
      JSON.stringify(snapshot),
      JSON.stringify({
        createdBy: "retry-failed-candidate-analysis-batch",
        createdAt: now.toISOString(),
        note: "失败候选重分析后自动加入执行队列。",
        matchScore: matchScore ?? undefined,
      }),
    ]
  );

  const affected =
    typeof insertResult?.affectedRows === "number" ? insertResult.affectedRows : 0;
  if (affected <= 0) {
    return { inserted: false, reason: "insert_ignored" };
  }

  await markCandidatePicked(campaignId, tiktokUsername, now);
  try {
    await enqueueFirstOutreach({
      campaignId,
      tiktokUsername,
      platformInfluencerId,
      snapshot,
    });
  } catch (e) {
    console.warn(
      `[retry-batch] enqueueFirstOutreach failed @${tiktokUsername}:`,
      e?.message || e
    );
  }
  return { inserted: true, reason: "inserted" };
}

async function processOne(row, opts) {
  const { dryRun } = opts;
  const username = row.tiktok_username;
  const out = {
    campaign_id: row.campaign_id,
    username,
    original_summary: row.analysis_summary,
    status: "pending",
  };

  try {
    const [tiktokRow, globalRow] = await Promise.all([
      loadTikTokInfluencer(username),
      loadGlobalInfluencer(username, row.influencer_id),
    ]);

    const influencer = buildInfluencerFromRow(row, tiktokRow, globalRow);
    const influencerProfile = parseJson(row.influencer_profile) || {};
    const productInfo = parseJson(row.product_info) || {};
    const campaignInfo = {
      ...(parseJson(row.campaign_info) || {}),
      platforms: parseJson(row.campaign_info)?.platforms || [row.campaign_platform].filter(Boolean),
      countries: parseJson(row.campaign_info)?.countries || [row.region].filter(Boolean),
      budget: parseJson(row.campaign_info)?.budget ?? row.budget,
      commission: parseJson(row.campaign_info)?.commission ?? row.commission,
    };

    out.has_profile_data = !!(influencer.profile_data && Object.keys(influencer.profile_data).length);
    out.search_video_count = influencer.search_video_data?.length || 0;

    if (dryRun) {
      out.status = "dry_run_skipped";
      return out;
    }

    const analysisResult = await analyzeInfluencerMatch(
      influencer,
      influencerProfile,
      productInfo,
      campaignInfo
    );

    out.retry_success = !isTechnicalAnalysisFailure(analysisResult);
    out.is_recommended = analysisResult.isRecommended;
    out.score = analysisResult.score;
    out.reason = analysisResult.reason;
    out.recovered_from_markdown = Boolean(analysisResult.recoveredFromMarkdown);

    if (!out.retry_success) {
      out.status = "still_failed";
      return out;
    }

    const merged = {
      ...influencer,
      isRecommended: analysisResult.isRecommended,
      recommendationReason: analysisResult.reason,
      recommendationScore: analysisResult.score,
      recommendationAnalysis: analysisResult.analysis,
      analysisSuccess: analysisResult.success,
    };

    await updateCandidateAfterReanalysis(row.campaign_id, username, merged, {
      runId: `retry-batch-${new Date().toISOString().slice(0, 10)}`,
    });

    out.status = "updated";
    const snapshot = buildNormalizedInfluencerSnapshot(merged, {});
    const email = snapshot.email;
    out.has_email = Boolean(email);

    if (analysisResult.isRecommended && email && !row.picked_at) {
      const exec = await tryInsertExecution({
        campaignId: row.campaign_id,
        tiktokUsername: username,
        platformInfluencerId: resolvePlatformInfluencerId(merged),
        snapshot,
        matchScore: analysisResult.score,
        dryRun: false,
      });
      out.execution = exec;
      if (exec.inserted) out.status = "updated_and_executed";
    }

    return out;
  } catch (e) {
    out.status = "error";
    out.error = e?.message || String(e);
    return out;
  }
}

async function runPool(items, concurrency, worker) {
  const results = [];
  let index = 0;

  async function runner() {
    while (index < items.length) {
      const i = index++;
      results[i] = await worker(items[i], i);
      if ((i + 1) % 10 === 0 || i + 1 === items.length) {
        console.log(`[retry-batch] progress ${i + 1}/${items.length}`);
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => runner()));
  return results;
}

async function main() {
  const opts = parseArgs();
  if (!process.env.DEEPSEEK_API_KEY && !opts.dryRun) {
    console.error("DEEPSEEK_API_KEY 未配置");
    process.exit(1);
  }

  console.log("[retry-batch] loading failure rows…");
  const rows = await fetchFailureRows(opts.limit);
  console.log(`[retry-batch] found ${rows.length} failures (concurrency=${opts.concurrency}, dryRun=${opts.dryRun})`);

  const started = Date.now();
  const results = await runPool(rows, opts.concurrency, (row) => processOne(row, opts));

  const summary = {
    total: results.length,
    retry_success: results.filter((r) => r.retry_success).length,
    still_failed: results.filter((r) => r.status === "still_failed").length,
    errors: results.filter((r) => r.status === "error").length,
    recommended: results.filter((r) => r.is_recommended).length,
    recommended_with_email: results.filter((r) => r.is_recommended && r.has_email).length,
    entered_execution: results.filter((r) => r.execution?.inserted).length,
    recovered_from_markdown: results.filter((r) => r.recovered_from_markdown).length,
    elapsed_ms: Date.now() - started,
    finished_at: new Date().toISOString(),
  };

  const outPath = path.join(projectRoot, "exports", `retry-failed-analysis-${Date.now()}.json`);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify({ summary, results }, null, 2));

  console.log("\n=== retry-failed-candidate-analysis-batch summary ===");
  console.log(JSON.stringify(summary, null, 2));
  console.log(`\nFull report: ${outPath}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
