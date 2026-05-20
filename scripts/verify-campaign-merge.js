/**
 * Phase C：验收 campaign 合并结果。
 *
 *   node scripts/verify-campaign-merge.js
 *   node scripts/verify-campaign-merge.js --session <id>
 *   node scripts/verify-campaign-merge.js --canonical CAMP-xxx
 */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import { queryTikTok } from "../lib/db/mysql-tiktok.js";
import {
  findDuplicateCampaignsForSession,
  listSessionsWithDuplicateCampaigns,
} from "../lib/db/merge-campaigns.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
dotenv.config({ path: path.join(projectRoot, ".env") });
dotenv.config({ path: path.join(projectRoot, ".env.local") });

const DEFAULT_SESSION = "dd7b7a6f-840c-4c3d-9aed-8bbfcd71de60";
const DEFAULT_CANONICAL = "CAMP-1779282660977-6H2FAB1G3";
const OLD_ID = "CAMP-1779282508785-LNET3FS0Q";

function parseArgs() {
  const out = {};
  const argv = process.argv;
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === "--session" && argv[i + 1]) out.session = argv[++i];
    if (argv[i] === "--canonical" && argv[i + 1]) out.canonical = argv[++i];
  }
  return out;
}

async function countByCampaign(campaignId) {
  const tables = [
    ["candidates", "tiktok_campaign_influencer_candidates"],
    ["execution", "tiktok_campaign_execution"],
    ["search_tasks", "tiktok_influencer_search_task"],
    ["keyword_runs", "tiktok_keyword_run_result"],
  ];
  const out = {};
  for (const [key, table] of tables) {
    const rows = await queryTikTok(
      `SELECT COUNT(*) AS n FROM ${table} WHERE campaign_id = ?`,
      [campaignId]
    );
    out[key] = Number(rows?.[0]?.n || 0);
  }
  const pending = await queryTikTok(
    `SELECT COUNT(*) AS n FROM tiktok_influencer_search_task
     WHERE campaign_id = ? AND status IN ('pending','processing')`,
    [campaignId]
  );
  out.search_tasks_active = Number(pending?.[0]?.n || 0);
  return out;
}

async function main() {
  const args = parseArgs();
  const sessionId = args.session || DEFAULT_SESSION;
  const canonicalId = args.canonical || DEFAULT_CANONICAL;

  console.log("=== Phase C 验收 ===\n");

  let failed = 0;

  const dupes = await listSessionsWithDuplicateCampaigns();
  const sessionDup = dupes.find((d) => d.sessionId === sessionId);
  if (sessionDup) {
    console.log(`❌ 会话 ${sessionId} 仍有 ${sessionDup.count} 条非 deleted campaign`);
    failed += 1;
  } else {
    console.log(`✅ 会话 ${sessionId} 无重复非 deleted campaign`);
  }

  const plan = await findDuplicateCampaignsForSession(sessionId);
  if (plan?.oldIds?.length) {
    console.log(`❌ 仍有待合并 oldIds: ${plan.oldIds.join(", ")}`);
    failed += 1;
  } else {
    console.log(`✅ findDuplicateCampaigns: canonical=${plan?.canonicalId || "—"}`);
  }

  const oldRow = await queryTikTok(
    `SELECT id, status, delete_reason FROM tiktok_campaign WHERE id = ?`,
    [OLD_ID]
  );
  if (oldRow?.[0]?.status === "deleted") {
    console.log(`✅ 旧 campaign ${OLD_ID} 已软删 (${oldRow[0].delete_reason || ""})`);
  } else if (oldRow?.[0]) {
    console.log(`❌ 旧 campaign ${OLD_ID} 状态仍为 ${oldRow[0].status}`);
    failed += 1;
  } else {
    console.log(`⚠️ 旧 campaign ${OLD_ID} 行不存在（可能已清理）`);
  }

  const oldCounts = await countByCampaign(OLD_ID);
  const orphanTotal = Object.values(oldCounts).reduce((a, b) => a + (typeof b === "number" ? b : 0), 0);
  if (orphanTotal > 0 && oldCounts.search_tasks_active > 0) {
    console.log(`❌ 旧 ID 仍有活跃搜索任务:`, oldCounts);
    failed += 1;
  } else if (orphanTotal > 0) {
    console.log(`⚠️ 旧 ID 仍有历史子表行（无活跃任务）:`, oldCounts);
  } else {
    console.log(`✅ 旧 ID 子表无残留业务行`);
  }

  const canonCounts = await countByCampaign(canonicalId);
  console.log(`\nCanonical ${canonicalId} 子表统计:`, canonCounts);

  const ctxRows = await queryTikTok(
    `SELECT JSON_UNQUOTE(JSON_EXTRACT(context, '$.campaignId')) AS cid
     FROM tiktok_campaign_sessions WHERE id = ?`,
    [sessionId]
  );
  const ctxCid = ctxRows?.[0]?.cid;
  if (ctxCid === canonicalId) {
    console.log(`✅ 会话 context.campaignId = ${ctxCid}`);
  } else {
    console.log(`❌ 会话 context.campaignId = ${ctxCid}（期望 ${canonicalId}）`);
    failed += 1;
  }

  console.log(failed ? `\n验收未通过（${failed} 项）` : "\n验收通过。");
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
