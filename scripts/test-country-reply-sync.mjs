import assert from "node:assert/strict";
import {
  extractCountryFromReplyText,
  resolveSnapshotCountry,
  resolveResidenceCountryUpdate,
  shouldAskCountryInOutreach,
} from "../lib/influencer/country-reply-sync.js";

assert.equal(
  extractCountryFromReplyText("I'm currently based in Canada.")?.iso,
  "CA"
);
assert.equal(
  extractCountryFromReplyText("We are located in the UK and can ship locally.")?.iso,
  "GB"
);
assert.equal(
  extractCountryFromReplyText("我现在常驻美国，可以合作。")?.iso,
  "US"
);
assert.equal(extractCountryFromReplyText("Thanks for getting back to us.")?.iso, undefined);
assert.equal(extractCountryFromReplyText("I can do it next week.")?.iso, undefined);
// 口径（2026-09 确认）：首封邮件只补「居住国家」；账号国家已知也要问，已答过就跳过。
assert.equal(
  shouldAskCountryInOutreach({ influencer: { region: "US" }, executionSnapshot: {} }),
  true,
  "只有平台 region 时仍要问居住国家"
);
assert.equal(
  shouldAskCountryInOutreach({
    influencer: {},
    executionSnapshot: { videoPublishCountry: "GB" },
  }),
  true,
  "只有账号国家时仍要问居住国家"
);
assert.equal(
  shouldAskCountryInOutreach({
    influencer: {},
    executionSnapshot: { residenceCountry: "GB" },
  }),
  false,
  "快照里已有居住国家 → 不再问"
);
assert.equal(
  shouldAskCountryInOutreach({ influencer: { residenceCountry: "JP" }, executionSnapshot: {} }),
  false,
  "主档已有居住国家（含跨 campaign 历史回复）→ 不再问"
);
assert.equal(
  shouldAskCountryInOutreach({ influencer: { residence_country: "JP" }, executionSnapshot: {} }),
  false,
  "下划线字段同样生效"
);
assert.equal(
  shouldAskCountryInOutreach({ influencer: {}, executionSnapshot: {} }),
  true
);

// --- profileDelta 护栏（LLM 结果 → 是否允许写库） ---
const selfResidence = resolveResidenceCountryUpdate({
  residenceCountry: "Japan",
  residenceRelation: "self_residence",
  residenceEvidenceQuote: "I'm based in Osaka, Japan.",
  residenceConfidence: 0.9,
});
assert.equal(selfResidence.ok, true);
assert.equal(selfResidence.iso, "JP");
assert.equal(selfResidence.relation, "self_residence");

assert.equal(
  resolveResidenceCountryUpdate({
    residenceCountry: "日本",
    residenceRelation: "self_residence",
    residenceEvidenceQuote: "我常驻日本，可以配合寄样。",
    residenceConfidence: 1,
  }).iso,
  "JP"
);

// 9/13 那类误判：问的是「你们客户是否来自中国」→ 不是红人常住地
assert.equal(
  resolveResidenceCountryUpdate({
    residenceCountry: "CN",
    residenceRelation: "other",
    residenceEvidenceQuote:
      "do most of your current clients and projects come from the Greater China region?",
    residenceConfidence: 0.9,
  }).ok,
  false
);

// 旅行/临时停留不写库
assert.equal(
  resolveResidenceCountryUpdate({
    residenceCountry: "ID",
    residenceRelation: "self_travel",
    residenceEvidenceQuote: "I'm traveling in Bali this week.",
    residenceConfidence: 0.9,
  }).reason,
  "not_self_residence"
);

// 没有原句证据不写库
assert.equal(
  resolveResidenceCountryUpdate({
    residenceCountry: "JP",
    residenceRelation: "self_residence",
    residenceEvidenceQuote: "",
    residenceConfidence: 0.9,
  }).reason,
  "missing_evidence"
);

// 置信度不足不写库
assert.equal(
  resolveResidenceCountryUpdate({
    residenceCountry: "JP",
    residenceRelation: "self_residence",
    residenceEvidenceQuote: "maybe Japan?",
    residenceConfidence: 0.4,
  }).reason,
  "low_confidence"
);

// 非法国家名不写库
assert.equal(
  resolveResidenceCountryUpdate({
    residenceCountry: "somewhere",
    residenceRelation: "self_residence",
    residenceEvidenceQuote: "I'm based somewhere nice.",
    residenceConfidence: 0.9,
  }).reason,
  "country_not_normalized"
);

assert.equal(
  resolveResidenceCountryUpdate(null).reason,
  "missing_profile_delta"
);

// --- 展示用生效国家：本人确认优先于平台值 ---
assert.equal(
  resolveSnapshotCountry({
    videoPublishCountry: "US",
    residenceCountry: "JP",
  }),
  "JP"
);
assert.equal(
  resolveSnapshotCountry({ residence_country: "ID", video_publish_country: "US" }),
  "ID"
);
assert.equal(resolveSnapshotCountry({ videoPublishCountry: "US" }), "US");
assert.equal(resolveSnapshotCountry({}), null);

// 已有本人确认常住地时不再追问国家
assert.equal(
  shouldAskCountryInOutreach({
    influencer: { residence_country: "JP" },
    executionSnapshot: {},
  }),
  false
);

console.log("country reply sync tests passed");
