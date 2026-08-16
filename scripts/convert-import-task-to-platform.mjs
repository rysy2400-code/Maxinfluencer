/**
 * 把旧的 mixed 导入任务转换为平台子任务（保留原 payload 行），并取消原任务。
 *
 * 用法:
 *   node scripts/convert-import-task-to-platform.mjs --source-task 59 --platform youtube
 */
import { randomUUID } from "crypto";
import { tiktokPool } from "../lib/db/mysql-tiktok.js";
import {
  createImportTask,
  getImportTaskById,
  cancelImportTask,
} from "../lib/db/influencer-import-task-dao.js";
import {
  splitImportRowsByPlatform,
  platformSubtaskBatchId,
  IMPORT_PLATFORM_SLUGS,
} from "../lib/influencer/import-platform-split.js";

function parseArgs(argv) {
  const out = { sourceTask: null, platform: null, priority: 200 };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--source-task" && argv[i + 1]) out.sourceTask = Number(argv[++i]);
    else if (a === "--platform" && argv[i + 1]) out.platform = String(argv[++i]).toLowerCase();
    else if (a === "--priority" && argv[i + 1]) out.priority = Number(argv[++i]) || 200;
  }
  return out;
}

function rowPlatformSlug(row) {
  return String(row?.platformSlug || row?.platform || "")
    .trim()
    .toLowerCase();
}

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

const rows = Array.isArray(source.payload?.rows) ? source.payload.rows : [];
if (!rows.length) {
  console.error(`任务 #${args.sourceTask} payload 无有效行`);
  process.exit(1);
}

let buckets;
if (args.platform) {
  if (!IMPORT_PLATFORM_SLUGS.includes(args.platform)) {
    console.error(`不支持的平台: ${args.platform}（支持 ${IMPORT_PLATFORM_SLUGS.join("/")}）`);
    process.exit(1);
  }
  const all = splitImportRowsByPlatform(rows);
  buckets = { [args.platform]: all[args.platform] || [] };
  const skipped = rows.length - buckets[args.platform].length;
  if (skipped > 0) {
    console.warn(`[convert] 跳过 ${skipped} 行非 ${args.platform} 平台行`);
  }
  if (!buckets[args.platform].length) {
    console.error(`任务 #${args.sourceTask} 没有 ${args.platform} 平台行`);
    process.exit(1);
  }
} else {
  buckets = splitImportRowsByPlatform(rows);
}

const baseBatchId = `IMP-CONV-${Date.now()}-${randomUUID().slice(0, 8)}`;
const batchGroupId = source.batch_group_id || baseBatchId;
const created = [];

for (const [slug, bucketRows] of Object.entries(buckets)) {
  if (!bucketRows.length) continue;
  const taskId = await createImportTask({
    campaignId: source.campaign_id,
    sessionId: source.session_id || null,
    importBatchId: platformSubtaskBatchId(baseBatchId, slug),
    batchGroupId,
    platform: slug,
    priority: args.priority,
    payload: {
      trigger: "import_platform_convert",
      importBatchId: baseBatchId,
      batchType: "split_platform",
      platform: slug,
      rows: bucketRows.map((r) => ({
        profileUrl: r.profileUrl,
        username: r.username,
        platform: r.platform,
        platformSlug: r.platformSlug || slug,
        email: r.email || null,
      })),
      sources: [`converted from task #${args.sourceTask}`],
    },
    totalRows: bucketRows.length,
    skippedDuplicateCount: 0,
    parseErrorCount: 0,
    sourceFileName: `convert-task-${args.sourceTask}.json`,
    sourceFileStorageKey: null,
  });
  created.push({ taskId, platform: slug, rows: bucketRows.length });
  console.log(`[convert] 已创建 task #${taskId} platform=${slug} rows=${bucketRows.length} batchGroup=${batchGroupId}`);
}

if (!created.length) {
  console.error("[convert] 没有可转换的平台子任务");
  process.exit(1);
}

const cancelled = await cancelImportTask(args.sourceTask, {
  reason: `converted_to_platform_subtasks:${created.map((c) => c.taskId).join(",")}`,
  resultSummary: `已转换为平台子任务 ${created.map((c) => `#${c.taskId}(${c.platform})`).join(", ")}`,
});
console.log(`[convert] 原任务 #${args.sourceTask} 已取消: ${cancelled}`);
await tiktokPool.end();
console.log("[convert] 完成");
