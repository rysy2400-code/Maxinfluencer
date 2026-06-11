/**
 * 从 running campaign 的分析失败候选中抽样，用当前 analyzeInfluencerMatch 重试。
 *
 * 用法: node scripts/retry-failed-analysis-sample.mjs [--limit=20] [--dry-run]
 */
import { queryTikTok } from "../lib/db/mysql-tiktok.js";
import { analyzeInfluencerMatch } from "../lib/tools/influencer-functions/analyze-influencer-match.js";

function parseJson(value) {
  if (value == null) return null;
  if (typeof value === "object") return value;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function classifyOriginal(summary) {
  const s = (summary || "").trim();
  if (s === "无法从响应中提取理由") return "reason_extract_failed";
  if (/fetch failed/i.test(s)) return "fetch_failed";
  if (/400/.test(s)) return "api_400";
  if (/terminated/i.test(s)) return "terminated";
  if (s === "分析失败" || s.startsWith("分析失败:")) return "other_analysis_failed";
  return "other";
}

function classifyRetry(result) {
  const reason = (result?.reason || "").trim();
  if (!result?.success) {
    if (/fetch failed/i.test(reason)) return "retry_fetch_failed";
    if (/400/.test(reason)) return "retry_api_400";
    if (/超时|timeout/i.test(reason)) return "retry_timeout";
    return "retry_llm_error";
  }
  if (reason === "无法从响应中提取理由") return "retry_still_no_json";
  if (reason === "分析失败" || reason.startsWith("分析失败:")) return "retry_analysis_failed";
  if (reason === "未提供理由") return "retry_no_reason";
  const hasAnalysis = !!(result?.analysis && String(result.analysis).trim());
  const hasJsonInAnalysis = /```json/i.test(result?.analysis || "");
  if (!hasAnalysis) return "retry_empty_analysis";
  return "retry_success";
}

function snapshotToInfluencer(snap) {
  if (!snap || typeof snap !== "object") return null;
  const followers = snap.followers;
  const views = snap.views;
  return {
    username: snap.username,
    displayName: snap.displayName,
    profileUrl: snap.profileUrl,
    platform: snap.platform,
    bio: snap.bio,
    verified: snap.verified,
    followers: followers,
    followers_count:
      typeof followers === "object" ? followers?.count : followers,
    followers_display:
      typeof followers === "object" ? followers?.display : undefined,
    views: views,
    avg_views: typeof views === "object" ? views?.avg : views,
    engagement: snap.engagement,
    postsCount: snap.postsCount,
    gmv: snap.gmv,
    gmvDisplay: snap.gmvDisplay,
    unitsSold: snap.unitsSold,
    unitsSoldDisplay: snap.unitsSoldDisplay,
    gmvPeriodDays: snap.gmvPeriodDays,
    video_publish_country: snap.videoPublishCountry,
    // 候选 snapshot 不含完整 profile_data / search_video_data（与线上一致性见脚本输出说明）
    profile_data: {},
    search_video_data: [],
  };
}

function buildCampaignInfo(row) {
  const ci = parseJson(row.campaign_info) || {};
  return {
    platforms: ci.platforms || [row.platform].filter(Boolean),
    countries: ci.countries || [row.region].filter(Boolean),
    budget: ci.budget ?? row.budget,
    commission: ci.commission ?? row.commission,
  };
}

async function fetchFailureSample(limit) {
  const rows = await queryTikTok(`
    SELECT
      c.id AS campaign_id,
      c.platform,
      c.region,
      c.budget,
      c.commission,
      c.product_info,
      c.campaign_info,
      c.influencer_profile,
      cc.tiktok_username,
      cc.analysis_summary,
      cc.match_score AS old_score,
      cc.should_contact AS old_should_contact,
      cc.influencer_snapshot,
      cc.match_analysis,
      cc.analyzed_at
    FROM tiktok_campaign c
    JOIN tiktok_campaign_influencer_candidates cc ON cc.campaign_id = c.id
    WHERE c.status = 'running'
      AND cc.analyzed_at IS NOT NULL
      AND (
        cc.analysis_summary = '无法从响应中提取理由'
        OR cc.analysis_summary LIKE '分析失败:%'
        OR cc.analysis_summary = '分析失败'
        OR cc.analysis_summary = '未提供理由'
        OR cc.analysis_summary IS NULL
        OR cc.analysis_summary = ''
      )
    ORDER BY cc.analyzed_at DESC
  `);

  const buckets = {
    reason_extract_failed: [],
    fetch_failed: [],
    api_400: [],
    other: [],
  };

  for (const row of rows) {
    const cat = classifyOriginal(row.analysis_summary);
    const key =
      cat === "reason_extract_failed"
        ? "reason_extract_failed"
        : cat === "fetch_failed"
          ? "fetch_failed"
          : cat === "api_400"
            ? "api_400"
            : "other";
    buckets[key].push(row);
  }

  const targetMix = [
    ["reason_extract_failed", Math.min(14, buckets.reason_extract_failed.length)],
    ["fetch_failed", Math.min(3, buckets.fetch_failed.length)],
    ["api_400", Math.min(3, buckets.api_400.length)],
  ];

  const picked = [];
  for (const [key, n] of targetMix) {
    picked.push(...buckets[key].slice(0, n));
  }

  const remain = limit - picked.length;
  if (remain > 0) {
    const used = new Set(picked.map((r) => `${r.campaign_id}:${r.tiktok_username}`));
    for (const row of rows) {
      const id = `${row.campaign_id}:${row.tiktok_username}`;
      if (used.has(id)) continue;
      picked.push(row);
      if (picked.length >= limit) break;
    }
  }

  return {
    picked: picked.slice(0, limit),
    pool: {
      reason_extract_failed: buckets.reason_extract_failed.length,
      fetch_failed: buckets.fetch_failed.length,
      api_400: buckets.api_400.length,
      other: buckets.other.length,
      total: rows.length,
    },
  };
}

async function main() {
  const args = process.argv.slice(2);
  const limitArg = args.find((a) => a.startsWith("--limit="));
  const limit = limitArg ? Math.max(1, parseInt(limitArg.split("=")[1], 10) || 20) : 20;
  const dryRun = args.includes("--dry-run");

  if (!process.env.DEEPSEEK_API_KEY) {
    console.error("DEEPSEEK_API_KEY 未配置，无法重试");
    process.exit(1);
  }

  const { picked, pool } = await fetchFailureSample(limit);
  console.log("=== 失败池规模（running campaigns）===");
  console.log(pool);
  console.log(`\n抽样 ${picked.length} 条（dry-run=${dryRun}）\n`);

  if (dryRun) {
    for (const row of picked) {
      console.log(
        `- @${row.tiktok_username} | ${row.campaign_id} | ${classifyOriginal(row.analysis_summary)} | ${row.analysis_summary}`
      );
    }
    return;
  }

  const results = [];
  for (let i = 0; i < picked.length; i++) {
    const row = picked[i];
    const snap = parseJson(row.influencer_snapshot);
    const influencer = snapshotToInfluencer(snap);
    const influencerProfile = parseJson(row.influencer_profile) || {};
    const productInfo = parseJson(row.product_info) || {};
    const campaignInfo = buildCampaignInfo(row);
    const originalCat = classifyOriginal(row.analysis_summary);
    const oldMa = parseJson(row.match_analysis) || {};
    const oldAnalysisLen = (oldMa.analysis || "").length;

    console.log(
      `[${i + 1}/${picked.length}] 重试 @${row.tiktok_username} (${originalCat})…`
    );

    const started = Date.now();
    let result;
    try {
      result = await analyzeInfluencerMatch(
        influencer,
        influencerProfile,
        productInfo,
        campaignInfo
      );
    } catch (e) {
      result = {
        success: false,
        reason: `分析失败: ${e.message}`,
        analysis: "",
        score: 0,
        isRecommended: false,
      };
    }
    const elapsedMs = Date.now() - started;
    const retryCat = classifyRetry(result);
    const hasJsonFence = /```json/i.test(result.analysis || "");

    results.push({
      username: row.tiktok_username,
      campaign_id: row.campaign_id,
      original_category: originalCat,
      original_summary: row.analysis_summary,
      old_analysis_len: oldAnalysisLen,
      retry_category: retryCat,
      retry_success: retryCat === "retry_success",
      retry_reason: result.reason,
      retry_score: result.score,
      retry_is_recommended: result.isRecommended,
      retry_analysis_len: (result.analysis || "").length,
      has_json_fence: hasJsonFence,
      elapsed_ms: elapsedMs,
    });

    console.log(
      `  → ${retryCat} | score=${result.score} recommended=${result.isRecommended} | ${Math.round(elapsedMs / 1000)}s`
    );
    console.log(`  → reason: ${String(result.reason).slice(0, 120)}`);

    if (i < picked.length - 1) {
      await new Promise((r) => setTimeout(r, 800));
    }
  }

  const successCount = results.filter((r) => r.retry_success).length;
  const byOriginal = {};
  const byRetry = {};
  for (const r of results) {
    byOriginal[r.original_category] = byOriginal[r.original_category] || { total: 0, success: 0 };
    byOriginal[r.original_category].total++;
    if (r.retry_success) byOriginal[r.original_category].success++;

    byRetry[r.retry_category] = (byRetry[r.retry_category] || 0) + 1;
  }

  console.log("\n=== 重试结果汇总 ===");
  console.log(
    `成功（得到有效 JSON reason + 有画像分析）: ${successCount}/${results.length} (${((100 * successCount) / results.length).toFixed(1)}%)`
  );
  console.log("\n按原始失败类型:");
  for (const [k, v] of Object.entries(byOriginal)) {
    console.log(
      `  ${k}: ${v.success}/${v.total} (${v.total ? ((100 * v.success) / v.total).toFixed(1) : 0}%)`
    );
  }
  console.log("\n按重试结果类型:");
  for (const [k, v] of Object.entries(byRetry).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${k}: ${v}`);
  }

  console.log("\n=== 明细 JSON ===");
  console.log(JSON.stringify(results, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
