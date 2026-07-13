/**
 * 验证 signal 归一化匹配与 IG hashtag 过滤逻辑。
 * 用法: node scripts/test-keyword-signals-match.js
 */
import { normalizeSignalMatchKey } from "../lib/db/campaign-keyword-signals-dao.js";

const assert = (cond, msg) => {
  if (!cond) throw new Error(msg);
};

assert(
  normalizeSignalMatchKey("#SaltWaterPool") === normalizeSignalMatchKey("saltwaterpool"),
  "hashtag normalize match"
);
assert(
  normalizeSignalMatchKey("@BeatBot") === normalizeSignalMatchKey("beatbot"),
  "mention normalize match"
);
assert(
  normalizeSignalMatchKey("#pool clean") === "pool clean",
  "strip hash only"
);

console.log("✅ keyword-signals match tests passed");
