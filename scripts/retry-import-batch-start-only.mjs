/**
 * 批量重试 import 失败红人，仅等待进入 processing 后退出（不全程 poll）。
 */
import { randomUUID } from "crypto";
import { queryTikTok } from "../lib/db/mysql-tiktok.js";
import { createImportTask, getImportTaskById } from "../lib/db/influencer-import-task-dao.js";
import {
  splitImportRowsByPlatform,
  platformSubtaskBatchId,
  IMPORT_PLATFORM_SLUGS,
} from "../lib/influencer/import-platform-split.js";

const SOURCE_TASK = Number(process.argv[2] || 10);
const DONE = new Set(
  String(process.env.RETRY_SKIP_HANDLES || "TryThisAI1,MattVidPro")
    .split(",")
    .map((s) => s.replace(/^@/, "").trim().toLowerCase())
    .filter(Boolean)
);

const FAILED_FROM_LOG = [
  "----",
  "YouTech34",
  "CryptoBrosVortex",
  "AI-ARENA-YT",
  "AiFinder11",
  "skillademia",
  "JustinSerranDigital",
  "Ai_Scope1",
  "planetai217",
  "NovaToolbox",
  "Web-3-World",
  "imskaigenerated",
  "VortexNextGen",
  "aisimplified100",
  "GregPreece",
  "NexcopeAI",
  "SoftRevz",
  "nathanhodgson.ai",
  "drcintas",
  "TechTutorZones",
].map((s) => s.toLowerCase());

function norm(u) {
  return String(u || "").replace(/^@/, "").trim().toLowerCase();
}

const sourceRows = await queryTikTok(
  `SELECT campaign_id, session_id, payload FROM tiktok_influencer_import_task WHERE id = ?`,
  [SOURCE_TASK]
);
if (!sourceRows?.[0]) {
  console.error("source task not found");
  process.exit(1);
}

const payload =
  typeof sourceRows[0].payload === "string"
    ? JSON.parse(sourceRows[0].payload)
    : sourceRows[0].payload;
const campaignId = sourceRows[0].campaign_id;
const sessionId = sourceRows[0].session_id;
const want = new Set(FAILED_FROM_LOG.filter((h) => !DONE.has(h)));
const rows = (payload.rows || []).filter((r) => want.has(norm(r.username)));

if (!rows.length) {
  console.error("no rows to retry");
  process.exit(1);
}

const handles = rows.map((r) => norm(r.username)).filter(Boolean);
const ph = handles.map(() => "?").join(", ");
await queryTikTok(
  `DELETE FROM tiktok_campaign_influencer_candidates WHERE campaign_id = ? AND LOWER(tiktok_username) IN (${ph})`,
  [campaignId, ...handles]
);

const importBatchId = `IMP-RETRY-${Date.now()}-${randomUUID().slice(0, 8)}`;
const buckets = splitImportRowsByPlatform(rows);
const taskIds = [];
for (const [slug, bucketRows] of IMPORT_PLATFORM_SLUGS.map((slug) => [slug, buckets[slug] || []])) {
  if (!bucketRows.length) continue;
  const taskId = await createImportTask({
    campaignId,
    sessionId,
    importBatchId: platformSubtaskBatchId(importBatchId, slug),
    batchGroupId: importBatchId,
    platform: slug,
    priority: 200,
    payload: {
      trigger: "import_retry_batch",
      importBatchId,
      batchType: "split_platform",
      platform: slug,
      rows: bucketRows,
      sources: [`retry batch failures from task #${SOURCE_TASK}`],
    },
    totalRows: bucketRows.length,
    skippedDuplicateCount: 0,
    parseErrorCount: 0,
    sourceFileName: `retry-task-${SOURCE_TASK}-batch.json`,
    sourceFileStorageKey: null,
  });
  taskIds.push(taskId);
  console.log(
    `[batch-retry] created task #${taskId} platform=${slug} rows=${bucketRows.length} batch=${importBatchId}`
  );
}

console.log(`[batch-retry] handles: ${handles.join(", ")}`);

const waitSec = Math.max(30, Number(process.argv[3] || 120));
const deadline = Date.now() + waitSec * 1000;
while (Date.now() < deadline) {
  const states = [];
  for (const taskId of taskIds) {
    const t = await getImportTaskById(taskId);
    states.push(t?.status || "missing");
    if (t?.status === "processing") {
      console.log(
        JSON.stringify({
          event: "started",
          taskId: t.id,
          platform: t.platform,
          status: t.status,
          worker_ip: t.worker_ip,
          worker_id: t.worker_id,
          started_at: t.started_at,
          total_rows: t.total_rows,
        })
      );
      process.exit(0);
    }
  }
  if (states.every((s) => ["succeeded", "failed", "cancelled"].includes(s))) {
    console.log(
      JSON.stringify({
        event: "already_finished",
        taskIds,
        statuses: states,
      })
    );
    process.exit(0);
  }
  await new Promise((r) => setTimeout(r, 4000));
}

console.log(JSON.stringify({ event: "timeout_pending", taskIds, waitSec }));
process.exit(2);
