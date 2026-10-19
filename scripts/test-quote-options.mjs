import assert from "node:assert/strict";
import {
  mergeQuoteOptions,
  normalizeQuoteOptions,
  resolveQuoteOptionsFromRow,
  resolveSelectedQuoteOptionFromRow,
} from "../lib/execution/quote-options.js";
import {
  resolveExecutionAgreedTerms,
} from "../lib/execution/agreed-terms.js";
import {
  resolveQuoteApproveCharge,
} from "../lib/billing/approve-quote-charge.js";

const firstRound = normalizeQuoteOptions(
  [
    {
      optionLabel: "Option 1",
      flatFeeUSD: 1003,
      commissionPercent: 0,
      deliverables: {
        platforms: ["YouTube"],
        videoCount: 1,
        note: "2-3 minute Halloween film",
      },
    },
    {
      optionLabel: "Option 2",
      flatFeeUSD: 1003,
      commissionPercent: 0,
      deliverables: {
        platforms: ["YouTube"],
        videoCount: 1,
        note: "Approximately 5 minute film",
      },
    },
  ],
  {
    sourceEventId: 100,
    sourceMessageId: "<message-100@example.com>",
    quoteRoundId: "QR-100",
  }
);
assert.equal(firstRound.length, 2);
assert.equal(firstRound[0].optionId, "QR-100-01");

const duplicateConfirmation = mergeQuoteOptions(
  firstRound,
  normalizeQuoteOptions(
    [
      {
        optionLabel: "Option 1",
        flatFeeUSD: 1003,
        commissionPercent: 0,
        deliverables: {
          platforms: ["YouTube"],
          videoCount: 1,
          note: "2-3 minute Halloween film",
        },
      },
    ],
    { sourceEventId: 101, quoteRoundId: "QR-101" }
  )
);
assert.equal(duplicateConfirmation.length, 2, "confirmation must not append a row");

const withFourthOption = mergeQuoteOptions(
  firstRound,
  normalizeQuoteOptions(
    [
      {
        optionLabel: "Option 3",
        flatFeeUSD: 1338,
        commissionPercent: 0,
        deliverables: {
          platforms: ["YouTube"],
          videoCount: 1,
          note: "Case study video",
        },
      },
    ],
    { sourceEventId: 102, quoteRoundId: "QR-102" }
  )
);
assert.equal(withFourthOption.length, 3);

const multiRow = {
  quote_negotiation: JSON.stringify(firstRound),
  last_event: JSON.stringify({ quoteOptions: firstRound }),
  flat_fee: 1338,
  currency: "USD",
  commission_percent: 0,
  quote_origin: "creator_quote",
  source: "web_search",
};
const options = resolveQuoteOptionsFromRow(multiRow);
assert.equal(options.length, 2);
assert.equal(resolveSelectedQuoteOptionFromRow(multiRow), null);

const noSelectionTerms = resolveExecutionAgreedTerms(null, multiRow);
assert.equal(noSelectionTerms.quoteOptionSelectionRequired, true);
const noSelectionCharge = resolveQuoteApproveCharge(null, multiRow);
assert.equal(noSelectionCharge.ok, false);
assert.equal(noSelectionCharge.code, "quote_option_required");

const selectedRow = {
  ...multiRow,
  last_event: JSON.stringify({
    quoteOptions: firstRound,
    selectedQuoteOptionId: firstRound[1].optionId,
  }),
};
const selected = resolveSelectedQuoteOptionFromRow(selectedRow);
assert.equal(selected?.optionId, firstRound[1].optionId);
const selectedCharge = resolveQuoteApproveCharge(null, selectedRow);
assert.equal(selectedCharge.ok, true);
assert.equal(selectedCharge.fixedFeeUsd, 1003);
assert.equal(selectedCharge.quoteOptionId, firstRound[1].optionId);

console.log("[TEST] quote options OK");
