/**
 * 修复 ai_wagasiyasan / Miora Campaign：
 * 红人后续已把方案调整为 JPY 150,000（约 USD 1,003），但旧事件只写入了
 * last_event.specialRequestResolved，没有写入 quote_negotiation 和 flat_fee。
 *
 * 用法：
 *   node scripts/backfill-ai-wagasiyasan-quote-options.mjs
 *   node scripts/backfill-ai-wagasiyasan-quote-options.mjs --apply
 */
import { tiktokPool, queryTikTok } from "../lib/db/mysql-tiktok.js";
import {
  SQL_EXECUTION_CREATOR_MATCH,
  paramsExecutionCreatorMatch,
} from "../lib/db/campaign-execution-keys.js";
import { parseQuoteNegotiation } from "../lib/execution/quote-resolution.js";

const APPLY = process.argv.includes("--apply");
const campaignId = "CAMP-1788260979200-APW0DKQL7";
const influencerId = "UC6h55i5AZABbtRvi5KYO7PQ";
const roundId = "QR-ai-wagasiyasan-20261014";

const quoteOptions = [
  {
    optionId: "OPT-ai-wagasiyasan-halloween-film",
    quoteRoundId: roundId,
    optionLabel: "Option 1",
    amountUsd: 1003,
    currency: "USD",
    commissionPercent: 0,
    deliverables: {
      platforms: ["YouTube"],
      videoCount: 1,
      note: "原创万圣节短片 2–3 分钟，不含教程",
    },
    reason: "JPY 150,000 tax included (approximately USD 1,003)",
    sourceEventId: 8267,
    sourceMessageId: "<CAAoi-Qf3shP0JysfAuQrE=Y5FE+iw7kRK5kJ_8XKmqL=wAVP+g@mail.gmail.com>",
    at: "2026-10-14T02:11:09.000Z",
  },
  {
    optionId: "OPT-ai-wagasiyasan-longer-film",
    quoteRoundId: roundId,
    optionLabel: "Option 2",
    amountUsd: 1003,
    currency: "USD",
    commissionPercent: 0,
    deliverables: {
      platforms: ["YouTube"],
      videoCount: 1,
      note: "约 5 分钟原创短片",
    },
    reason: "JPY 150,000 tax included (approximately USD 1,003)",
    sourceEventId: 8267,
    sourceMessageId: "<CAAoi-Qf3shP0JysfAuQrE=Y5FE+iw7kRK5kJ_8XKmqL=wAVP+g@mail.gmail.com>",
    at: "2026-10-14T02:11:09.000Z",
  },
];

const rows = await queryTikTok(
  `SELECT id, stage, flat_fee, currency, quote_origin, quote_negotiation, last_event
   FROM tiktok_campaign_execution
   WHERE campaign_id = ? AND ${SQL_EXECUTION_CREATOR_MATCH}
   LIMIT 1`,
  [campaignId, ...paramsExecutionCreatorMatch(influencerId)]
);
const row = rows?.[0];
if (!row) throw new Error("未找到目标执行记录");

const history = parseQuoteNegotiation(row.quote_negotiation);
const existingOptionIds = new Set(
  history.map((entry) => entry?.optionId).filter(Boolean)
);
const quoteEntries = quoteOptions
  .filter((option) => !existingOptionIds.has(option.optionId))
  .map((option) => ({
    role: "influencer",
    type: "option",
    optionId: option.optionId,
    quoteRoundId: option.quoteRoundId,
    optionLabel: option.optionLabel,
    amount: option.amountUsd,
    currency: option.currency,
    commissionPercent: option.commissionPercent,
    deliverables: option.deliverables,
    reason: option.reason,
    at: option.at,
    source: "backfill_special_request",
    sourceEventId: option.sourceEventId,
  }));
const nextHistory = [...history, ...quoteEntries];
const lastEvent =
  typeof row.last_event === "string"
    ? JSON.parse(row.last_event || "{}")
    : row.last_event || {};
const nextLastEvent = {
  ...lastEvent,
  quoteOptions,
  quoteOptionsUpdatedAt: "2026-10-19T03:27:47.000Z",
  selectedQuoteOptionId: null,
  campaignAgentDecision: {
    ...(lastEvent.campaignAgentDecision || {}),
    flatFeeUSD: 1003,
    commissionPercent: 0,
    quoteOptions,
    selectedQuoteOptionId: null,
  },
};

console.log(
  JSON.stringify(
    {
      apply: APPLY,
      before: {
        stage: row.stage,
        flatFee: row.flat_fee,
        currency: row.currency,
        quoteHistoryCount: history.length,
      },
      after: {
        stage: row.stage,
        flatFee: 1003,
        currency: "USD",
        quoteHistoryCount: nextHistory.length,
        quoteOptions,
        selectedQuoteOptionId: null,
      },
    },
    null,
    2
  )
);

if (!APPLY) {
  console.log("[dry-run] 未写库；加 --apply 执行。");
  await tiktokPool.end();
  process.exit(0);
}

await queryTikTok(
  `UPDATE tiktok_campaign_execution
   SET flat_fee = 1003,
       currency = 'USD',
       quote_origin = 'creator_quote',
       quote_negotiation = ?,
       last_event = ?
   WHERE campaign_id = ? AND ${SQL_EXECUTION_CREATOR_MATCH}`,
  [
    JSON.stringify(nextHistory),
    JSON.stringify(nextLastEvent),
    campaignId,
    ...paramsExecutionCreatorMatch(influencerId),
  ]
);
console.log("[apply] 已修复报价方案与固定费。");
await tiktokPool.end();
