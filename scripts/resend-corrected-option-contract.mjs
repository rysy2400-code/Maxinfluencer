/**
 * 按指定报价方案重发修订合同。
 *
 * 用法：
 *   node scripts/resend-corrected-option-contract.mjs \
 *     --campaign CAMP-xxx \
 *     --handle ai_wagasiyasan \
 *     --option-id OPT-xxx \
 *     --deliverables-note-en "Original 2-3 minute Halloween film; no tutorial." \
 *     --change-summary "..." \
 *     --revision 2 \
 *     --apply [--hold]
 */
import { getExecutionRow, updateExecutionStage } from "../lib/db/campaign-dao.js";
import { enqueueContractEmail } from "../lib/contract/enqueue-contract-email.js";
import { generateContractForExecution } from "../lib/contract/generate-contract.js";
import { resolveQuoteOptionsFromRow } from "../lib/execution/quote-options.js";
import { normalizeDeliverables } from "../lib/execution/deliverables-resolution.js";
import { queryTikTok } from "../lib/db/mysql-tiktok.js";

function readArg(name) {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx === -1) return null;
  const value = process.argv[idx + 1];
  return value && !value.startsWith("--") ? value : "";
}

const apply = process.argv.includes("--apply");
const hold = process.argv.includes("--hold");
const campaignId = String(readArg("campaign") || "").trim();
const handle = String(readArg("handle") || "").replace(/^@/, "").trim();
const optionId = String(readArg("option-id") || "").trim();
const deliverablesNoteEn = String(readArg("deliverables-note-en") || "").trim();
const changeSummary = String(readArg("change-summary") || "").trim();
const revisionArg = Number(readArg("revision"));

if (!campaignId || !handle || !optionId || !deliverablesNoteEn || !changeSummary) {
  console.error(
    "缺少参数：--campaign --handle --option-id --deliverables-note-en --change-summary"
  );
  process.exit(1);
}

const row = await getExecutionRow(campaignId, handle);
if (!row) {
  throw new Error(`未找到执行记录：${campaignId}/${handle}`);
}
const option = resolveQuoteOptionsFromRow(row).find(
  (item) => item.optionId === optionId
);
if (!option) {
  throw new Error(`未找到报价方案：${optionId}`);
}

const lastEvent = row.lastEvent || {};
const prevRevision = Number(lastEvent.contractRevision);
const nextRevision =
  Number.isFinite(revisionArg) && revisionArg >= 2
    ? Math.floor(revisionArg)
    : Number.isFinite(prevRevision) && prevRevision >= 1
      ? Math.floor(prevRevision) + 1
      : 2;
const correctedDeliverables = normalizeDeliverables({
  ...(option.deliverables || {}),
  note: deliverablesNoteEn,
});
const previousApprovedTerms = lastEvent.approvedTerms || {};
const correctedApprovedTerms = {
  ...previousApprovedTerms,
  fixedFeeUsd: option.amountUsd,
  commissionPercent: option.commissionPercent ?? 0,
  currency: option.currency || "USD",
  quoteOptionId: option.optionId,
  quoteOptionLabel: option.optionLabel || optionId,
  deliverables: correctedDeliverables,
};

console.log(
  JSON.stringify(
    {
      apply,
      hold,
      campaignId,
      handle: row.tiktok_username || handle,
      influencerId: row.influencer_id || null,
      currentSelectedOptionId: lastEvent.selectedQuoteOptionId || null,
      correctedOption: option,
      correctedDeliverables,
      revision: nextRevision,
      changeSummary,
    },
    null,
    2
  )
);

if (!apply) {
  console.log("[dry-run] 未写库、未生成或发送合同。");
  process.exit(0);
}

await updateExecutionStage(campaignId, row.tiktok_username || handle, {
  lastEvent: {
    selectedQuoteOptionId: option.optionId,
    selectedQuoteOptionAt: new Date().toISOString(),
    approvedTerms: correctedApprovedTerms,
    contractRevision: nextRevision,
  },
});

const regeneratedRow = await getExecutionRow(campaignId, row.tiktok_username || handle);
if (!regeneratedRow) throw new Error("纠正后未找到执行记录");

const generated = await generateContractForExecution({
  campaignId,
  influencerHandle: regeneratedRow.tiktok_username || handle,
  influencerId: regeneratedRow.influencer_id || null,
  revision: nextRevision,
  feeAmountOverride: option.amountUsd,
});
console.log(`[generated] ${generated.contractNo}`);
console.log(`[generated] ${generated.storageKey}`);
console.log(`[deliverables] ${generated.deliverablesText}`);

const { eventId } = await enqueueContractEmail({
  campaignId,
  influencerHandle: regeneratedRow.tiktok_username || handle,
  platformInfluencerId: regeneratedRow.influencer_id || null,
  contract: {
    contractNo: generated.contractNo,
    storageKey: generated.storageKey,
    absPath: generated.absPath,
    clauses: generated.clauses,
    changeSummary,
  },
});

if (hold) {
  await queryTikTok(
    `UPDATE tiktok_influencer_agent_event SET status = 'processing', updated_at = NOW() WHERE id = ?`,
    [eventId]
  );
}

console.log(
  JSON.stringify(
    {
      eventId,
      held: hold,
      contractNo: generated.contractNo,
      storageKey: generated.storageKey,
      deliverablesText: generated.deliverablesText,
      nextStep: hold
        ? `手动处理事件 ${eventId}: node --experimental-default-type=module scripts/process-influencer-agent-events.js --mode=urgent --event-id ${eventId} --force-claim`
        : "Worker 下一轮自动发送",
    },
    null,
    2
  )
);
