import assert from "node:assert/strict";
import { shouldFallbackThreadSender } from "../lib/email/influencer-thread-mail.js";

assert.equal(
  shouldFallbackThreadSender({ email: "james@xinfluencer.fun" }),
  true,
  "clientHold 域名必须触发动态池回退"
);
assert.equal(
  shouldFallbackThreadSender({ email: "annie@minfluencer.site" }),
  true,
  "已从发信池移除的 minfluencer 域名必须触发回退"
);
assert.equal(
  shouldFallbackThreadSender({ email: "maxin@ainfluencer.site" }),
  false,
  "健康域不应触发回退"
);
assert.equal(shouldFallbackThreadSender(null), false, "空账号无需回退");

console.log("thread sender fallback: ok");
