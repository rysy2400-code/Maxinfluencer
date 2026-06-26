/**
 * 交付结果（Deliverables）单元测试
 * 用法：node scripts/test-deliverables.js
 */
import {
  DEFAULT_DELIVERABLES,
  DEFAULT_DELIVERABLES_EN,
  formatDeliverablesForOutreach,
  formatDeliverablesLabel,
  getDefaultDeliverables,
  mergeDeliverablesExtracted,
} from "../lib/campaign/deliverables.js";

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

console.log("mergeDeliverablesExtracted → default on new campaign");
assert(
  mergeDeliverablesExtracted(null, {}) === DEFAULT_DELIVERABLES,
  "expected default"
);

console.log("mergeDeliverablesExtracted → keep existing");
assert(
  mergeDeliverablesExtracted(null, { deliverables: "自定义" }) === "自定义",
  "expected existing"
);

console.log("formatDeliverablesLabel → null for legacy");
assert(formatDeliverablesLabel(null) === null, "legacy null");
assert(formatDeliverablesLabel("") === null, "legacy empty");

console.log("formatDeliverablesLabel → display");
const label = formatDeliverablesLabel(DEFAULT_DELIVERABLES);
assert(label && label.includes("1条专属视频"), "expected label");

console.log("formatDeliverablesForOutreach → default EN");
assert(
  formatDeliverablesForOutreach(DEFAULT_DELIVERABLES) === DEFAULT_DELIVERABLES_EN,
  "expected EN default"
);

console.log("formatDeliverablesForOutreach → null when unset");
assert(formatDeliverablesForOutreach(null) === null, "expected null");

console.log("\n✅ test-deliverables passed");
