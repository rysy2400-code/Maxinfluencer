#!/usr/bin/env node
/**
 * Lite TikTok 导入三阶段测试
 *
 * 用法:
 *   node scripts/test-import-tiktok-lite.mjs [handle]
 *   TEST_TT_IMPORT_REQUIRE_ENRICH=1 node scripts/test-import-tiktok-lite.mjs designsyshouse
 *
 * 断言模式:
 *   默认（smoke）: 任务 succeeded 即通过（国家不符时 enriched=0 仍算流水线成功）
 *   REQUIRE_ENRICH=1:  additionally 要求 progress_enriched_count >= 1
 */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import XLSX from "xlsx";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
dotenv.config({ path: path.join(root, ".env") });
dotenv.config({ path: path.join(root, ".env.local") });

process.env.SCRAPER_MODE = process.env.SCRAPER_MODE || "lite";

const requireEnrich =
  String(process.env.TEST_TT_IMPORT_REQUIRE_ENRICH || "").trim() === "1";
const handleArg = String(process.argv[2] || process.env.TEST_TT_IMPORT_HANDLE || "")
  .replace(/^@/, "")
  .trim();
const defaultHandle = "learnnextaigen";
const testUsername = handleArg || defaultHandle;
const TEST_HANDLES = [
  {
    username: testUsername,
    profileUrl: `https://www.tiktok.com/@${testUsername}`,
  },
];

function parseJsonField(v) {
  if (v == null) return null;
  if (typeof v === "object") return v;
  try {
    return JSON.parse(v);
  } catch {
    return null;
  }
}

console.log(
  `[test] handle=@${testUsername}${handleArg ? " (cli)" : " (default)"} mode=${requireEnrich ? "require_enrich" : "smoke"}`
);

async function main() {
  const { queryTikTok } = await import("../lib/db/mysql-tiktok.js");
  const { parseInfluencerListXlsx } = await import(
    "../lib/influencer/parse-influencer-list-xlsx.js"
  );
  const { applyAttachmentExtractionPlan, DEFAULT_ATTACHMENT_ROW_RULES } =
    await import("../lib/influencer/apply-extraction-plan.js");
  const { processInfluencerImportTask } = await import(
    "../lib/influencer/process-import-task.js"
  );
  const { resolveAllowedCountriesFromCampaign } = await import(
    "../lib/influencer/campaign-country-codes.js"
  );

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    wb,
    XLSX.utils.aoa_to_sheet([
      ["主页链接", "邮箱", "平台"],
      ...TEST_HANDLES.map((h) => [h.profileUrl, "", "tk"]),
    ]),
    "Creators"
  );
  const buffer = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });

  const autoParsed = parseInfluencerListXlsx(buffer);
  console.log("[parse] autoParsed.rows=", autoParsed.rows.length);
  for (const r of autoParsed.rows) {
    console.log(`  auto: @${r.username} platform=${r.platform} slug=${r.platformSlug}`);
  }
  if (!autoParsed.rows.length) {
    console.error("[FAIL] parseInfluencerListXlsx 未识别 TikTok 行");
    process.exit(2);
  }

  const campaigns = await queryTikTok(
    `SELECT id, session_id, status, campaign_info AS campaignInfo, influencer_profile AS influencerProfile
     FROM tiktok_campaign
     WHERE status IN ('running','running_passive')
     ORDER BY created_at DESC LIMIT 1`
  );
  const campaign = campaigns?.[0];
  if (!campaign?.id) {
    console.error("[FAIL] 无 running campaign，无法测试 import task");
    process.exit(2);
  }
  const campaignInfo = parseJsonField(campaign.campaignInfo) || {};
  const allowedCountries = resolveAllowedCountriesFromCampaign(campaignInfo);
  console.log(
    `[campaign] id=${campaign.id} session=${campaign.session_id} countries=${allowedCountries.join(",") || "(none)"}`
  );

  const importBatchId = `TEST-IMP-${Date.now()}`;
  const payload = {
    trigger: "test_import_tiktok_lite",
    importBatchId,
    rows: autoParsed.rows.map((r) => ({
      profileUrl: r.profileUrl,
      username: r.username,
      platform: r.platform,
      platformSlug: r.platformSlug,
      email: r.email || null,
    })),
    sources: ["test script"],
  };

  const insert = await queryTikTok(
    `INSERT INTO tiktok_influencer_import_task (
      campaign_id, session_id, import_batch_id, platform, priority,
      payload, status, total_rows, source_file_name
    ) VALUES (?, ?, ?, 'mixed', 200, ?, 'processing', ?, 'test-import-tiktok.xlsx')`,
    [
      campaign.id,
      campaign.session_id,
      importBatchId,
      JSON.stringify(payload),
      payload.rows.length,
    ]
  );
  const taskId = insert?.insertId;
  if (!taskId) {
    console.error("[FAIL] 创建 import task 失败");
    process.exit(2);
  }
  console.log(`[task] created id=${taskId} rows=${payload.rows.length}`);

  const taskRows = await queryTikTok(
    `SELECT * FROM tiktok_influencer_import_task WHERE id = ?`,
    [taskId]
  );
  const task = taskRows[0];
  task.payload = payload;

  const t0 = Date.now();
  const result = await processInfluencerImportTask(task, {});
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

  const finished = await queryTikTok(
    `SELECT status, result_summary, progress_enriched_count, progress_analyzed_count,
            progress_country_checked_count, progress_country_passed_count, error_message
     FROM tiktok_influencer_import_task WHERE id = ?`,
    [taskId]
  );
  const fin = finished?.[0] || {};

  const candidates = await queryTikTok(
    `SELECT tiktok_username, email, has_email, should_contact, source, analyzed_at
     FROM tiktok_campaign_influencer_candidates
     WHERE campaign_id = ? AND tiktok_username IN (${TEST_HANDLES.map(() => "?").join(",")})`,
    [campaign.id, ...TEST_HANDLES.map((h) => h.username)]
  );

  const report = {
    success: result?.success,
    elapsedSec: elapsed,
    taskStatus: fin.status,
    countryChecked: fin.progress_country_checked_count,
    countryPassed: fin.progress_country_passed_count,
    enriched: fin.progress_enriched_count,
    analyzed: fin.progress_analyzed_count,
    recommended: result?.recommendedCount,
    candidates: (candidates || []).map((c) => ({
      u: c.tiktok_username,
      email: c.email,
      has_email: c.has_email,
      should_contact: c.should_contact,
      source: c.source,
    })),
    summaryPreview: String(fin.result_summary || "").split("\n").slice(0, 6).join("\n"),
  };

  console.log("\n========== 测试结果 ==========");
  console.log(report);

  const pipelineOk = result?.success === true && fin.status === "succeeded";
  const enrichOk = Number(fin.progress_enriched_count) >= 1;
  const ok = pipelineOk && (requireEnrich ? enrichOk : true);

  if (!ok) {
    if (!pipelineOk) console.error("[FAIL] 流水线未成功完成");
    if (requireEnrich && !enrichOk) {
      console.error(
        "[FAIL] REQUIRE_ENRICH=1 但 enriched=0（可能国家不符或 CDP 不可用）"
      );
    }
  } else if (!enrichOk) {
    console.log(
      "[PASS] smoke 模式：流水线成功（国家未通过或未 enrich，符合预期时可忽略 enriched=0）"
    );
  } else {
    console.log("[PASS] 流水线成功且已完成 enrich");
  }

  process.exit(ok ? 0 : 1);
}

main().catch((e) => {
  console.error("[fatal]", e?.message || e);
  process.exit(1);
});
