import assert from "node:assert/strict";
import {
  isBounceEmail,
  normalizeEmailAddress,
  normalizeMessageId,
} from "../lib/email/email-delivery-classification.js";
import { mysqlTime } from "../lib/db/email-delivery-fact-dao.js";

assert.equal(normalizeMessageId(" <ABC@example.com> "), "abc@example.com");
assert.equal(normalizeEmailAddress("Creator <HELLO@example.com>"), "hello@example.com");
assert.equal(isBounceEmail({ fromEmail: "Mailer-Daemon@example.com" }), true);
assert.equal(isBounceEmail({ subject: "Delivery Status Notification (Failure)" }), true);
assert.equal(isBounceEmail({ bodyText: "Final-Recipient: rfc822; bad@example.com" }), true);
assert.equal(isBounceEmail({ subject: "Automatic reply: vacation", bodyText: "Out of office" }), false);
assert.equal(isBounceEmail({ fromEmail: "delivery.creator@example.com", subject: "Re: collaboration" }), false);
assert.equal(mysqlTime("2026-07-24 14:04:25"), "2026-07-24 14:04:25");
assert.equal(mysqlTime(new Date("2026-07-24T06:04:25.000Z")), "2026-07-24 06:04:25");

console.log("email delivery classification: ok");
