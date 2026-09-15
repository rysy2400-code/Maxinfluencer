/**
 * 画像语言 / 沟通语言推断单测。
 *   node scripts/test-influencer-language.mjs
 */
import assert from "node:assert/strict";
import {
  detectBioLanguageProfile,
  resolveCommunicationLanguage,
  normalizeLanguageCode,
  languageEnglishName,
} from "../lib/influencer/infer-bio-language.js";

// --- 文字系统：高置信度 ---
assert.deepEqual(detectBioLanguageProfile("こんにちは、東京で活動しています"), {
  language: "ja",
  confidence: 0.95,
  source: "script",
});
assert.equal(detectBioLanguageProfile("한국 뷰티 크리에이터").language, "ko");
assert.equal(detectBioLanguageProfile("美妆博主，商务合作请私信").language, "zh");
assert.equal(detectBioLanguageProfile("مرحبا، أنا منشئ محتوى").language, "ar");

// --- 拉丁词表：东南亚主力市场（旧检测器会误判成英语）---
assert.equal(
  detectBioLanguageProfile("Konten kreator makanan di Jakarta, hubungi untuk kerjasama").language,
  "id"
);
assert.equal(
  detectBioLanguageProfile("Đây là kênh của tôi, liên hệ hợp tác").language,
  "vi"
);
assert.equal(
  detectBioLanguageProfile("Türkiye de yaşıyorum, kanal iletişim reklam işbirliği").language,
  "tr"
);

// --- 英语识别 ---
assert.equal(
  detectBioLanguageProfile("Photographer based in LA. Business inquiries: hi@example.com").language,
  "en"
);

// --- 弱证据与未知 ---
assert.deepEqual(detectBioLanguageProfile("xoxo"), {
  language: null,
  confidence: 0,
  source: null,
});
assert.equal(detectBioLanguageProfile(null).language, null);
const asciiOnly = detectBioLanguageProfile("Zyx qwerty plmokn");
assert.equal(asciiOnly.language, "en");
assert.equal(asciiOnly.confidence, 0.4, "纯 ASCII 兜底必须是低置信度，不能用于自动切换语言");

// --- 语言代码归一化 ---
assert.equal(normalizeLanguageCode("EN-us"), "en");
assert.equal(normalizeLanguageCode("pt_BR"), "pt");
assert.equal(normalizeLanguageCode("xx"), null);
assert.equal(normalizeLanguageCode(""), null);
assert.equal(languageEnglishName("id"), "Indonesian");

// --- 发信语言优先级：回复语言 > bio 语言（过线）> 英语 ---
assert.deepEqual(resolveCommunicationLanguage({}), {
  language: "en",
  source: "default",
  bioLanguage: null,
});
assert.equal(
  resolveCommunicationLanguage({ bioLanguage: "id", bioLanguageConfidence: 0.75 }).language,
  "id"
);
assert.equal(
  resolveCommunicationLanguage({ bioLanguage: "id", bioLanguageConfidence: 0.4 }).language,
  "en",
  "bio 置信度不足时回退英语"
);
const replyWins = resolveCommunicationLanguage({
  replyLanguage: "es-419",
  bioLanguage: "en",
  bioLanguageConfidence: 0.85,
});
assert.equal(replyWins.language, "es");
assert.equal(replyWins.source, "reply");

// 红人来回切换语言：最近一次回复优先
assert.equal(
  resolveCommunicationLanguage({
    replyLanguage: "en",
    bioLanguage: "es",
    bioLanguageConfidence: 0.85,
  }).language,
  "en"
);

console.log("✅ test-influencer-language 全部通过");
