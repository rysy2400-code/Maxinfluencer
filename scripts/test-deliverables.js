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
  normalizeDeliverablesText,
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

console.log("mergeDeliverablesExtracted → normalize object from LLM");
const mergedObj = mergeDeliverablesExtracted(
  {
    YouTube: "1条 Youtube 专属视频\n广告加热权限：60天",
    Instagram: "1条 Instagram Reel",
  },
  {}
);
assert(mergedObj.includes("YouTube："), "expected YouTube line");
assert(mergedObj.includes("Instagram："), "expected Instagram line");
assert(!mergedObj.includes("[object Object]"), "must not contain object string");

console.log("formatDeliverablesLabel → null for legacy");
assert(formatDeliverablesLabel(null) === null, "legacy null");
assert(formatDeliverablesLabel("") === null, "legacy empty");
assert(formatDeliverablesLabel("[object Object]") === null, "corrupt object string");

console.log("formatDeliverablesLabel → display");
const label = formatDeliverablesLabel(DEFAULT_DELIVERABLES);
assert(label && label.includes("1条专属视频"), "expected label");

console.log("formatDeliverablesLabel → multi-line by platform");
const multi = formatDeliverablesLabel({
  YouTube: "1条 Youtube 专属视频\n广告加热权限：60天",
  Instagram: "1条 Instagram Reel\nAd code: 60天",
});
assert(multi && multi.includes("\n"), "expected platform line breaks");
assert(multi.includes("YouTube："), "expected YouTube prefix");
assert(multi.includes("Instagram："), "expected Instagram prefix");

console.log("normalizeDeliverablesText → object to canonical string");
const normalized = normalizeDeliverablesText({
  youtube: "1条视频",
  instagram: "1条 Reel",
});
assert(normalized.startsWith("YouTube："), "YouTube first in order");
assert(normalized.includes("\nInstagram："), "Instagram on new line");

console.log("formatDeliverablesForOutreach → default EN");
assert(
  formatDeliverablesForOutreach(DEFAULT_DELIVERABLES) === DEFAULT_DELIVERABLES_EN,
  "expected EN default"
);

console.log("formatDeliverablesForOutreach → null when unset");
assert(formatDeliverablesForOutreach(null) === null, "expected null");

console.log("getDefaultDeliverables");
assert(getDefaultDeliverables() === DEFAULT_DELIVERABLES, "expected default constant");

console.log("\n✅ test-deliverables passed");
