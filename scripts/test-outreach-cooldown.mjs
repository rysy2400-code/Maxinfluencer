import assert from "node:assert/strict";
import {
  OUTREACH_COOLDOWN_MAX_MS,
  OUTREACH_COOLDOWN_MIN_MS,
  createOutreachCooldown,
  resolveOutreachNextEligibleMs,
} from "../lib/email/outreach-cooldown.js";

const sentAt = new Date("2026-07-25T00:00:00.000Z");
const min = createOutreachCooldown({ sentAt, random: () => 0 });
const max = createOutreachCooldown({ sentAt, random: () => 1 });
const middle = createOutreachCooldown({ sentAt, random: () => 0.5 });

assert.equal(min.durationMs, OUTREACH_COOLDOWN_MIN_MS);
assert.equal(max.durationMs, OUTREACH_COOLDOWN_MAX_MS);
assert.equal(middle.durationMs, 30 * 60_000);
assert.equal(
  resolveOutreachNextEligibleMs({
    lastAt: sentAt,
    persistedNextEligibleAt: middle.nextEligibleAt,
  }),
  sentAt.getTime() + 30 * 60_000
);
assert.equal(
  resolveOutreachNextEligibleMs({ lastAt: sentAt }),
  sentAt.getTime() + OUTREACH_COOLDOWN_MAX_MS
);

console.log("outreach cooldown tests passed");
