/**
 * 小批量重试红人导入：从候选池删除指定 handle → 新建 pending import task → 轮询结果。
 *
 * 用法:
 *   node scripts/retry-failed-import-batch.mjs --source-task 10 --usernames TryThisAI1,MattVidPro,sferro21
 *   node scripts/retry-failed-import-batch.mjs --source-task 10 --sample
 */
import { randomUUID } from "crypto";
import { queryTikTok } from "../lib/db/mysql-tiktok.js";
import { createImportTask, getImportTaskById } from "../lib/db/influencer-import-task-dao.js";
import {
  splitImportRowsByPlatform,
  platformSubtaskBatchId,
  IMPORT_PLATFORM_SLUGS,
} from "../lib/influencer/import-platform-split.js";

const SAMPLE_USERNAMES = ["TryThisAI1", "MattVidPro", "sferro21"];

function parseArgs(argv) {
  const out = { sourceTask: null, usernames: [], sample: false, waitSec: 600 };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--source-task" && argv[i + 1]) {
      out.sourceTask = Number(argv[++i]);
    } else if (a === "--usernames" && argv[i + 1]) {
      out.usernames = String(argv[++i])
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    } else if (a === "--sample") {
      out.sample = true;
    } else if (a === "--wait-sec" && argv[i + 1]) {
      out.waitSec = Math.max(60, Number(argv[++i]) || 600);
    }
  }
  return out;
}

function normalizeHandle(username) {
  return String(username || "").replace(/^@/, "").trim().toLowerCase();
}

async function sleep(ms) {
  await new Promise((r) => setTimeout(r, ms));
}

async function main() {
  const args = parseArgs(process.argv);
  if (!args.sourceTask) {
    console.error("缺少 --source-task <id>");
    process.exit(1);
  }

  const source = await getImportTaskById(args.sourceTask);
  if (!source) {
    console.error(`未找到 import task #${args.sourceTask}`);
    process.exit(1);
  }

  const usernames =
    args.sample || !args.usernames.length ? SAMPLE_USERNAMES : args.usernames;
  const handleSet = new Set(usernames.map(normalizeHandle));
  const rows = (source.payload?.rows || []).filter((r) =>
    handleSet.has(normalizeHandle(r.username))
  );

  if (!rows.length) {
    console.error("源任务 payload 中未匹配到指定 usernames:", usernames.join(", "));
    process.exit(1);
  }

  const campaignId = source.campaign_id;
  const sessionId = source.session_id || null;
  const handles = rows.map((r) => normalizeHandle(r.username)).filter(Boolean);
  const placeholders = handles.map(() => "?").join(", ");

  console.log(`[retry-import] campaign=${campaignId} sourceTask=${args.sourceTask}`);
  console.log(`[retry-import] 重试 ${rows.length} 位: ${handles.join(", ")}`);

  const del = await queryTikTok(
    `
    DELETE FROM tiktok_campaign_influencer_candidates
    WHERE campaign_id = ? AND LOWER(tiktok_username) IN (${placeholders})
  `,
    [campaignId, ...handles]
  );
  console.log(`[retry-import] 已从候选池删除 ${Number(del?.affectedRows || 0)} 条`);

  const importBatchId = `IMP-RETRY-${Date.now()}-${randomUUID().slice(0, 8)}`;
  const buckets = splitImportRowsByPlatform(rows);
  const supportedBuckets = IMPORT_PLATFORM_SLUGS.map((slug) => [slug, buckets[slug] || []]);
  const taskIds = [];

  for (const [slug, bucketRows] of supportedBuckets) {
    if (!bucketRows.length) continue;
    const payload = {
      trigger: "import_retry_validation",
      importBatchId,
      batchType: "split_platform",
      platform: slug,
      rows: bucketRows,
      sources: [`retry from task #${args.sourceTask}`],
      retryUsernames: bucketRows.map((r) => normalizeHandle(r.username)),
    };
    const taskId = await createImportTask({
      campaignId,
      sessionId,
      importBatchId: platformSubtaskBatchId(importBatchId, slug),
      batchGroupId: importBatchId,
      platform: slug,
      priority: 200,
      payload,
      totalRows: bucketRows.length,
      skippedDuplicateCount: 0,
      parseErrorCount: 0,
      sourceFileName: `retry-task-${args.sourceTask}.json`,
      sourceFileStorageKey: null,
    });
    if (!taskId) {
      console.error(`[retry-import] 创建 ${slug} import task 失败`);
      process.exit(1);
    }
    taskIds.push(taskId);
    console.log(
      `[retry-import] 已创建 pending task #${taskId} platform=${slug} rows=${bucketRows.length} batch=${importBatchId}`
    );
  }

  if (!taskIds.length) {
    console.error("[retry-import] 没有可重试的平台子任务");
    process.exit(1);
  }

  const deadline = Date.now() + args.waitSec * 1000;
  const finished = new Map();
  while (Date.now() < deadline && finished.size < taskIds.length) {
    for (const taskId of taskIds) {
      if (finished.has(taskId)) continue;
      const t = await getImportTaskById(taskId);
      if (!t) {
        finished.set(taskId, { missing: true });
        continue;
      }
      console.log(
        `[retry-import] poll task=${taskId} platform=${t.platform} status=${t.status} enriched=${t.progress_enriched_count} analyzed=${t.progress_analyzed_count} worker=${t.worker_ip || "-"}`
      );
      if (["succeeded", "failed", "cancelled"].includes(t.status)) {
        finished.set(taskId, t);
      }
    }
    if (finished.size < taskIds.length) await sleep(8000);
  }

  if (finished.size < taskIds.length) {
    console.error("[retry-import] 等待超时，仍有子任务未完成");
    process.exit(2);
  }

  console.log("\n[retry-import] === 最终结果 ===");
  const lastRows = [];
  let allSucceeded = true;
  for (const taskId of taskIds) {
    const t = finished.get(taskId);
    lastRows.push(t);
    console.log(
      JSON.stringify(
        {
          id: t.id,
          platform: t.platform,
          status: t.status,
          worker_ip: t.worker_ip,
          worker_id: t.worker_id,
          progress_enriched_count: t.progress_enriched_count,
          progress_analyzed_count: t.progress_analyzed_count,
          progress_recommended_count: t.progress_recommended_count,
          error_message: t.error_message,
          result_summary: t.result_summary,
          started_at: t.started_at,
          finished_at: t.finished_at,
        },
        null,
        2
      )
    );
    if (t.status !== "succeeded") allSucceeded = false;
  }

  if (!allSucceeded) {
    process.exit(3);
  }

  const candRows = await queryTikTok(
    `
    SELECT tiktok_username, match_score, analysis_summary, influencer_snapshot
    FROM tiktok_campaign_influencer_candidates
    WHERE campaign_id = ? AND LOWER(tiktok_username) IN (${placeholders})
  `,
    [campaignId, ...handles]
  );

  function checkComplete(row) {
    const snap =
      typeof row.influencer_snapshot === "string"
        ? JSON.parse(row.influencer_snapshot)
        : row.influencer_snapshot;
    const platform = String(snap?.platform || "").toLowerCase();
    const issues = [];
    if (!snap?.followers?.count) issues.push("followers=0");
    if (!snap?.views?.avg && !snap?.views?.count) issues.push("views缺失");
    if (platform === "youtube" || platform === "instagram") {
      if (!snap?.videoPublishCountry && !snap?.video_publish_country) {
        issues.push("country缺失");
      }
    }
    if (!row.match_score && !String(row.analysis_summary || "").includes("评估")) {
      issues.push("画像分析不完整");
    }
    return { username: row.tiktok_username, ok: issues.length === 0, issues, snap };
  }

  console.log("\n[retry-import] === 数据完整性 ===");
  let allOk = true;
  for (const row of candRows || []) {
    const r = checkComplete(row);
    console.log(JSON.stringify(r, null, 2));
    if (!r.ok) allOk = false;
  }

  const ok =
    Number(last.progress_enriched_count) > 0 || Number(last.progress_analyzed_count) > 0;
  if (!ok) {
    console.error("[retry-import] 任务 succeeded 但 enriched/analyzed 仍为 0，可能再次被跳过");
    process.exit(4);
  }
  if (!allOk) {
    console.error("[retry-import] 部分红人数据仍不完整");
    process.exit(5);
  }

  console.log("[retry-import] ✅ 小批量重试通过");
}

main().catch((e) => {
  console.error("[retry-import] fatal:", e?.message || e);
  process.exit(1);
});
