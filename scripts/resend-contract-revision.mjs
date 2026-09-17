/**
 * 针对某个 campaign + 红人，按「最新交付结果」重发一版合同（R2/R3…）。
 *
 * 用途：合同已发出后才发现交付结果（平台/条数/时效）写错，需要更正并重发。
 * 前提：该执行行 quote_negotiation 上已有正确的 deliverables 记录
 *       （可用 scripts/backfill-execution-deliverables.mjs 回填）。
 *
 * 本脚本只做三件事（默认 dry-run，传 --apply 才写库）：
 *   1. 把 last_event.contractRevision 推到下一版（默认 2，或用 --revision 指定）
 *   2. 把最新交付结果冻结进 last_event.approvedTerms.deliverables
 *   3. 入队 send_contract_email（带 changeSummary），由 worker 生成 PDF 并发送
 *
 * 注意：必须在 worker 已部署最新代码后再执行 --apply，
 *       否则 worker 会用旧逻辑重新生成错误条款。
 *
 *   node scripts/resend-contract-revision.mjs --campaign CAMP-xxx --handle xxx \
 *     --change-summary "The Deliverables clause now reflects the agreed scope."
 */
import { getExecutionRow, updateExecutionStage } from "../lib/db/campaign-dao.js";
import { enqueueContractEmail } from "../lib/contract/enqueue-contract-email.js";
import {
  formatDeliverablesSummary,
  resolveLatestDeliverablesFromRow,
} from "../lib/execution/deliverables-resolution.js";

function readArg(name) {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx === -1) return null;
  const value = process.argv[idx + 1];
  return value && !value.startsWith("--") ? value : "";
}

const apply = process.argv.includes("--apply");
const campaignId = String(readArg("campaign") || "").trim();
const handle = String(readArg("handle") || "").replace(/^@/, "").trim();
const revisionArg = Number(readArg("revision"));
const changeSummary =
  String(readArg("change-summary") || "").trim() ||
  "The Deliverables clause has been corrected to reflect the publishing scope actually agreed by email.";

if (!campaignId || !handle) {
  console.error(
    "用法：node scripts/resend-contract-revision.mjs --campaign CAMP-xxx --handle <handle> [--revision 2] [--change-summary \"...\"] [--apply]"
  );
  process.exit(1);
}

const row = await getExecutionRow(campaignId, handle);
if (!row) {
  console.error(`未找到执行行：campaign=${campaignId} handle=${handle}`);
  process.exit(1);
}

const deliverables = resolveLatestDeliverablesFromRow(row);
if (!deliverables) {
  console.error(
    "该执行行没有红人级交付结果（quote_negotiation[].deliverables）。请先用 scripts/backfill-execution-deliverables.mjs 回填，再重发合同。"
  );
  process.exit(1);
}

const lastEvent = row.lastEvent || {};
const prevRevision = Number(lastEvent.contractRevision);
const nextRevision =
  Number.isFinite(revisionArg) && revisionArg >= 2
    ? Math.floor(revisionArg)
    : Number.isFinite(prevRevision) && prevRevision >= 1
      ? Math.floor(prevRevision) + 1
      : 2;

const approvedTerms = lastEvent.approvedTerms
  ? { ...lastEvent.approvedTerms, deliverables }
  : null;

if (!approvedTerms) {
  console.error(
    "该执行行没有 last_event.approvedTerms（品牌尚未点过同意？）。请确认这单已完成审批再重发合同。"
  );
  process.exit(1);
}

console.log("[resend-contract-revision] 目标：");
console.log(
  JSON.stringify(
    {
      campaignId,
      handle: row.tiktok_username || handle,
      influencerId: row.influencer_id || null,
      stage: row.stage,
      flatFee: row.flat_fee,
      currency: row.currency,
      nextRevision,
      deliverablesSummary: formatDeliverablesSummary(deliverables),
      changeSummary,
    },
    null,
    2
  )
);

if (!apply) {
  console.log(
    "\n[dry-run] 未写库、未入队；确认 worker 已部署最新代码后，追加 --apply 执行。"
  );
  process.exit(0);
}

await updateExecutionStage(campaignId, handle, {
  lastEvent: {
    contractRevision: nextRevision,
    approvedTerms,
  },
});

const { eventId } = await enqueueContractEmail({
  campaignId,
  influencerHandle: row.tiktok_username || handle,
  platformInfluencerId: row.influencer_id || null,
  contract: { changeSummary },
});

console.log(
  `\n[applied] 已写入 contractRevision=${nextRevision}，并已入队 send_contract_email（eventId=${eventId}）。worker 下一轮会生成 R${nextRevision} 合同并发送。`
);
