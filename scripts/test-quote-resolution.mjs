import assert from "node:assert/strict";
import { resolveLatestInfluencerQuote } from "../lib/execution/quote-resolution.js";

const history = [
  { role: "influencer", amount: 1050, currency: "USD" },
  { role: "advertiser", type: "counter", amount: 200, currency: "USD" },
];

assert.equal(
  resolveLatestInfluencerQuote({ quoteNegotiation: history, fallbackAmount: 200 })?.amount,
  1050
);
assert.equal(
  resolveLatestInfluencerQuote({
    quoteNegotiation: [...history, { role: "influencer", amount: 200, currency: "USD" }],
    fallbackAmount: 1050,
  })?.amount,
  200
);
assert.equal(
  resolveLatestInfluencerQuote({ quoteNegotiation: [], fallbackAmount: 450 })?.amount,
  450
);

console.log("quote resolution checks passed");
