import assert from "node:assert/strict";
import {
  isBounceEmail,
  normalizeEmailAddress,
  normalizeMessageId,
} from "../lib/email/email-delivery-classification.js";

assert.equal(normalizeMessageId(" <ABC@example.com> "), "abc@example.com");
assert.equal(normalizeEmailAddress("Creator <HELLO@example.com>"), "hello@example.com");
assert.equal(isBounceEmail({ fromEmail: "Mailer-Daemon@example.com" }), true);
assert.equal(isBounceEmail({ subject: "Delivery Status Notification (Failure)" }), true);
assert.equal(isBounceEmail({ bodyText: "Final-Recipient: rfc822; bad@example.com" }), true);
assert.equal(isBounceEmail({ subject: "Automatic reply: vacation", bodyText: "Out of office" }), false);
assert.equal(isBounceEmail({ fromEmail: "delivery.creator@example.com", subject: "Re: collaboration" }), false);

console.log("email delivery classification: ok");
