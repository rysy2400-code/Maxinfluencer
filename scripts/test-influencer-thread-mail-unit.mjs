/**
 * 无数据库：仅校验 influencer-thread-mail 纯函数与 Message-ID 规范化。
 */
import assert from "assert";
import {
  buildCanonicalThreadSubject,
  normalizeMessageIdForHeader,
} from "../lib/email/influencer-thread-mail.js";

assert.strictEqual(
  buildCanonicalThreadSubject({ displayName: "Ada", username: "ada" }),
  "Binfluencer x Ada | Social Media Collaboration"
);
assert.strictEqual(
  buildCanonicalThreadSubject({ displayName: null, username: "@foo_bar" }),
  "Binfluencer x foo_bar | Social Media Collaboration"
);

assert.strictEqual(
  normalizeMessageIdForHeader("abc@host"),
  "<abc@host>"
);
assert.strictEqual(
  normalizeMessageIdForHeader("<abc@host>"),
  "<abc@host>"
);

console.log("[TEST] influencer-thread-mail unit OK");
