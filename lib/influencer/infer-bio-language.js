/**
 * 从频道/主页简介文本推断语言，并与 campaign 投放国家主语言比对（无 About 国家时的轻量门禁）
 */

import { ISO_PRIMARY_LANGUAGE } from "./country-primary-language.js";
import { normalizeAllowedCountries } from "./campaign-country-codes.js";

/** 拉丁字母简介常见词（轻量打分，无第三方语言库） */
const LATIN_HINTS = {
  en: /\b(the|and|for|with|your|our|about|channel|subscribe|video|review|welcome|hello|contact|business|email|watch|daily|official)\b/gi,
  es: /\b(el|la|los|las|de|en|y|para|con|canal|video|bienvenidos|contacto|correo|hola|nuestro)\b/gi,
  fr: /\b(le|la|les|de|et|pour|avec|chaîne|chaine|video|bienvenue|contact|bonjour|notre)\b/gi,
  de: /\b(der|die|das|und|für|fur|mit|kanal|video|willkommen|kontakt|hallo|unser)\b/gi,
  pt: /\b(o|a|os|as|de|e|para|com|canal|video|bem-vindo|contato|olá|ola|nosso)\b/gi,
  it: /\b(il|la|i|le|di|e|per|con|canale|video|benvenuto|contatto|ciao|nostro)\b/gi,
  nl: /\b(de|het|en|voor|met|kanaal|video|welkom|contact|hallo|ons)\b/gi,
};

function detectScriptLanguage(text) {
  if (/[\u3040-\u30ff]/.test(text)) return "ja";
  if (/[\uac00-\ud7af]/.test(text)) return "ko";
  if (/[\u4e00-\u9fff]/.test(text)) return "zh";
  if (/[\u0600-\u06ff]/.test(text)) return "ar";
  if (/[\u0400-\u04ff]/.test(text)) return "ru";
  if (/[\u0e00-\u0e7f]/.test(text)) return "th";
  if (/[\u0900-\u097f]/.test(text)) return "hi";
  return null;
}

function scoreLatinLanguage(text) {
  let best = null;
  let bestScore = 0;
  for (const [lang, re] of Object.entries(LATIN_HINTS)) {
    const matches = text.match(re);
    const score = matches ? matches.length : 0;
    if (score > bestScore) {
      bestScore = score;
      best = lang;
    }
  }
  if (bestScore > 0) return best;
  if (/[a-zA-Z]{3,}/.test(text) && /^[\x00-\x7F\s.,!?#@\-_'":;()/&%+]*$/.test(text)) {
    return "en";
  }
  return null;
}

/**
 * @param {string|null|undefined} bio
 * @returns {string|null} BCP-47 简码，如 en / es / zh
 */
export function detectBioLanguage(bio) {
  const text = String(bio || "").trim();
  if (text.length < 6) return null;
  return detectScriptLanguage(text) || scoreLatinLanguage(text);
}

/**
 * @param {string[]} allowedCountriesIso
 * @returns {string[]}
 */
export function resolveCampaignLanguages(allowedCountriesIso) {
  const countries = normalizeAllowedCountries(allowedCountriesIso);
  return [
    ...new Set(
      countries
        .map((iso) => ISO_PRIMARY_LANGUAGE[String(iso).toUpperCase()] || null)
        .filter(Boolean)
    ),
  ];
}

/**
 * About 无国家时：bio 语言是否与 campaign 投放国家主语言可能一致
 * @param {string|null|undefined} bio
 * @param {string[]} allowedCountriesIso
 * @returns {{
 *   mayMatch: boolean,
 *   bioLanguage: string|null,
 *   campaignLanguages: string[],
 *   source: string|null,
 * }}
 */
export function bioLanguageMayMatchCampaign(bio, allowedCountriesIso) {
  const campaignLanguages = resolveCampaignLanguages(allowedCountriesIso);
  if (!campaignLanguages.length) {
    return {
      mayMatch: true,
      bioLanguage: null,
      campaignLanguages: [],
      source: null,
    };
  }

  const bioLanguage = detectBioLanguage(bio);
  if (!bioLanguage) {
    return {
      mayMatch: false,
      bioLanguage: null,
      campaignLanguages,
      source: "bio_language_unknown",
    };
  }

  const mayMatch = campaignLanguages.includes(bioLanguage);
  return {
    mayMatch,
    bioLanguage,
    campaignLanguages,
    source: mayMatch ? "bio_language_maybe" : "bio_language_mismatch",
  };
}

/**
 * About 无国家时的 Lite enrich 门禁：仅 bio 语言可识别且明确不符时拦截；bio 空/不可识别则放行。
 * @param {string|null|undefined} bio
 * @param {string[]} allowedCountriesIso
 * @returns {{
 *   proceed: boolean,
 *   countrySource: string|null,
 *   skippedReason: string|null,
 *   bioLanguage: string|null,
 * }}
 */
export function resolveUnknownCountryBioGate(bio, allowedCountriesIso) {
  const hit = bioLanguageMayMatchCampaign(bio, allowedCountriesIso);
  if (hit.bioLanguage && !hit.mayMatch) {
    return {
      proceed: false,
      countrySource: null,
      skippedReason: "bio_language_mismatch",
      bioLanguage: hit.bioLanguage,
    };
  }
  return {
    proceed: true,
    countrySource: hit.source === "bio_language_maybe" ? "bio_language_maybe" : null,
    skippedReason: null,
    bioLanguage: hit.bioLanguage,
  };
}

/* -------------------------------------------------------------------------
 * 以下为「红人画像语言」与「沟通语言」推断。
 *
 * 与上面的抓取门禁分开：
 * - 抓取门禁（detectBioLanguage / resolveUnknownCountryBioGate）词表与兜底逻辑保持不变，
 *   避免影响投放国家过滤的跳过率；
 * - 这里用更完整的词表与置信度，供红人卡片展示语言、以及决定发信语言。
 * ---------------------------------------------------------------------- */

/**
 * 扩展拉丁词表：只用于画像语言/沟通语言推断。
 *
 * 收录原则（踩过的坑）：
 * - 不收 TLD / 邮箱里会出现的词（com、net …），否则 "xxx@gmail.com" 会被判成葡语；
 * - 不收与英语同形的高频词（contact、canal、biz …），否则英语简介被判成罗语/土耳其语；
 * - 不收国名 / 城市名（indonesia、jakarta、paris、türkiye …），那是地理位置不是语言，
 *   否则「英文简介里提到某国」会被判成该国语言。
 */
const PROFILE_LATIN_HINTS = {
  en: /\b(the|and|with|your|you|our|subscribe|welcome|business|inquiries|collab|collabs|collaborations|creator|content|official|based in|lifestyle|vlog|vlogs|foodie|fitness|mom|dad|coach|artist|designer|photographer|chef|blogger|gamer|makeup|skincare|fashion|travel|unboxing|giveaway|review|reviews|family|life|style|home|food|love|art|music|faith|author|beauty|cute|outfits|everyday|tips|guide|host|founder|podcast|editor)\b/gi,
  id: /\b(yang|dan|untuk|dengan|saya|kami|konten|kreator|kerjasama|endorse|hubungi|terima kasih|bisnis|diskusi|banget|kalian|sehari)\b/gi,
  ms: /\b(yang|dan|untuk|dengan|saya|kami|kandungan|kerjasama|hubungi|terima kasih|sembang)\b/gi,
  vi: /\b(và|của|cho|với|tôi|mình|kênh|kenh|liên hệ|lien he|hợp tác|hop tac|cảm ơn|cam on|nội dung|theo dõi|đăng ký)\b/gi,
  // ang / pag 这类 2-3 字母词会误命中 "Angé…"、URL 之类，故不收录
  tl: /\b(mga|ako|namin|buhay|pagkain|salamat|mahal|ating)\b/gi,
  es: /\b(el|los|las|para|con|mi|canal|correo|contacto|bienvenidos|hola|nuestro|soy|espanol|español|recetas|viajes|belleza|colaboracion|colaboración|contenido|diseño|diseños)\b/gi,
  fr: /\b(les|des|une|pour|avec|mes|mon|chaine|chaîne|bonjour|francais|français|cuisine|voyage|beaute|beauté|createur|créateur|collaboration)\b/gi,
  de: /\b(der|die|das|und|für|fur|mit|mein|kanal|hallo|willkommen|kontakt|fotografie|reisen|deutsch|zusammenarbeit)\b/gi,
  pt: /\b(voce|você|nao|não|para|canal|contato|olá|ola|bem-vindo|nosso|sou|viagem|receitas|beleza|parceria|conteudo|conteúdo)\b/gi,
  it: /\b(gli|per|con|canale|contatti|ciao|benvenuto|nostro|sono|viaggi|cucina|bellezza|collaborazione)\b/gi,
  nl: /\b(het|een|voor|met|kanaal|welkom|hallo|onze|reizen|samenwerking)\b/gi,
  tr: /\b(ve|için|icin|ile|bir|ben|kanal|iletişim|iletisim|merhaba|reklam|işbirliği|isbirligi|içerik|icerik)\b/gi,
  pl: /\b(się|sie|jest|dla|oraz|kanał|kanal|kontakt|cześć|czesc|współpraca|wspolpraca)\b/gi,
  // 不收无变音的 si：会命中 YouTube 链接里的 "?si=xxx"
  ro: /\b(și|pentru|cu|sunt|bună|buna|colaborare)\b/gi,
  sv: /\b(och|att|jag|kanal|valkommen|välkommen|samarbete)\b/gi,
  da: /\b(og|jeg|kanal|velkommen|samarbejde)\b/gi,
  no: /\b(og|jeg|kanal|velkommen|samarbeid)\b/gi,
  fi: /\b(minä|mina|kanava|yhteys|tervetuloa|yhteistyo|yhteistyö)\b/gi,
  cs: /\b(jsem|kanaly|ahoj|spoluprace|spolupráce)\b/gi,
  hu: /\b(és|vagyok|csatorna|kapcsolat|szia|egyuttmukodes)\b/gi,
};

/** 拉丁词表命中排序优先级：同分时靠前者胜出（英语优先，避免过度推断小语种） */
const PROFILE_LANGUAGE_PRIORITY = Object.keys(PROFILE_LATIN_HINTS);

/** 沟通/画像语言可用的 BCP-47 简码白名单 */
export const KNOWN_LANGUAGE_CODES = new Set([
  ...PROFILE_LANGUAGE_PRIORITY,
  "ja",
  "ko",
  "zh",
  "ar",
  "ru",
  "uk",
  "he",
  "el",
  "th",
  "hi",
  "bn",
  "ta",
  "te",
  "ne",
  "si",
  "ur",
  "fa",
  "my",
  "km",
  "lo",
  "ka",
  "hy",
  "az",
  "kk",
  "uz",
  "mn",
  "sw",
  "sr",
  "hr",
  "sl",
  "sk",
  "lt",
  "lv",
  "et",
  "bg",
  "is",
  "mt",
  "sq",
  "be",
  "mk",
  "bs",
  "ca",
]);

/**
 * 归一化语言代码：大小写、区域后缀（en-US → en），并校验是否在白名单内。
 * @param {string|null|undefined} raw
 * @returns {string|null}
 */
export function normalizeLanguageCode(raw) {
  const s = String(raw == null ? "" : raw).trim();
  if (!s) return null;
  const base = s.replace(/_/g, "-").split("-")[0].trim().toLowerCase();
  if (!/^[a-z]{2,3}$/.test(base)) return null;
  return KNOWN_LANGUAGE_CODES.has(base) ? base : null;
}

/** 画像语言推断用的文字系统识别（比门禁版覆盖更多文字系统） */
function detectScriptLanguageProfile(text) {
  if (/[\u3040-\u30ff]/.test(text)) return "ja";
  if (/[\uac00-\ud7af]/.test(text)) return "ko";
  if (/[\u4e00-\u9fff]/.test(text)) return "zh";
  if (/[\u0600-\u06ff]/.test(text)) return "ar";
  if (/[\u0590-\u05ff]/.test(text)) return "he";
  if (/[\u0370-\u03ff]/.test(text)) return "el";
  if (/[\u0400-\u04ff]/.test(text)) return "ru";
  if (/[\u0e00-\u0e7f]/.test(text)) return "th";
  if (/[\u0900-\u097f]/.test(text)) return "hi";
  if (/[\u0980-\u09ff]/.test(text)) return "bn";
  if (/[\u0b80-\u0bff]/.test(text)) return "ta";
  if (/[\u0c00-\u0c7f]/.test(text)) return "te";
  if (/[\u0d80-\u0dff]/.test(text)) return "si";
  if (/[\u0e80-\u0eff]/.test(text)) return "lo";
  if (/[\u1000-\u109f]/.test(text)) return "my";
  if (/[\u1780-\u17ff]/.test(text)) return "km";
  if (/[\u0530-\u058f]/.test(text)) return "hy";
  if (/[\u10a0-\u10ff]/.test(text)) return "ka";
  return null;
}

/**
 * 红人画像语言：从 bio 推断语言 + 置信度（用于卡片展示与沟通语言兜底）。
 *
 * 置信度口径：
 * - 0.95 文字系统命中（日文/韩文/阿拉伯文等，几乎不会误判）
 * - 0.85 拉丁词表命中 >= 3 个词
 * - 0.75 拉丁词表命中 2 个词且高于次高
 * - 0.50 拉丁词表命中 1 个词且高于次高（弱证据）
 * - 0.40 纯 ASCII 且无任何词表命中 → 兜底按英语（弱证据，不用于切换发信语言）
 *
 * @param {string|null|undefined} bio
 * @returns {{language: string|null, confidence: number, source: string|null}}
 */
export function detectBioLanguageProfile(bio) {
  const text = String(bio || "").trim();
  if (text.length < 6) {
    return { language: null, confidence: 0, source: null };
  }

  const script = detectScriptLanguageProfile(text);
  if (script) {
    return { language: script, confidence: 0.95, source: "script" };
  }

  const scored = PROFILE_LANGUAGE_PRIORITY.map((lang) => {
    const matches = text.match(PROFILE_LATIN_HINTS[lang]);
    return { lang, score: matches ? matches.length : 0 };
  }).sort((a, b) => b.score - a.score);

  const best = scored[0];
  const second = scored[1] || { score: 0 };
  if (best.score >= 1 && best.score > second.score) {
    const confidence = best.score >= 3 ? 0.85 : best.score === 2 ? 0.75 : 0.5;
    return { language: best.lang, confidence, source: "latin_hint" };
  }

  // 没有词表命中时：拉丁字母 + 无变音符号（emoji/符号不影响判断）→ 兜底英语；
  // 出现变音符号（é / ñ / ã / ğ / ø …）说明更可能是其他拉丁语系语言，返回未知。
  const hasLatinDiacritics = /[\u00C0-\u024F\u1E00-\u1EFF]/.test(text);
  const hasAsciiWord = /[a-zA-Z]{3,}/.test(text);
  if (!hasLatinDiacritics && hasAsciiWord) {
    return { language: "en", confidence: 0.4, source: "ascii_default" };
  }

  return { language: null, confidence: 0, source: null };
}

/** 画像语言可用于「自动切换发信语言」的最低置信度 */
export const MIN_BIO_LANGUAGE_CONFIDENCE_FOR_OUTREACH = 0.7;

/** 语言英文名（用于给 LLM 的发信语言指令；缺失时回退语言代码） */
export const LANGUAGE_ENGLISH_NAMES = Object.freeze({
  en: "English",
  es: "Spanish",
  fr: "French",
  de: "German",
  pt: "Portuguese",
  it: "Italian",
  nl: "Dutch",
  id: "Indonesian",
  ms: "Malay",
  vi: "Vietnamese",
  tl: "Filipino",
  tr: "Turkish",
  pl: "Polish",
  ro: "Romanian",
  sv: "Swedish",
  da: "Danish",
  no: "Norwegian",
  fi: "Finnish",
  cs: "Czech",
  hu: "Hungarian",
  el: "Greek",
  ru: "Russian",
  uk: "Ukrainian",
  ar: "Arabic",
  he: "Hebrew",
  fa: "Persian",
  hi: "Hindi",
  bn: "Bengali",
  ta: "Tamil",
  te: "Telugu",
  ur: "Urdu",
  th: "Thai",
  ja: "Japanese",
  ko: "Korean",
  zh: "Chinese",
  my: "Burmese",
  km: "Khmer",
  lo: "Lao",
  si: "Sinhala",
  ne: "Nepali",
  ka: "Georgian",
  hy: "Armenian",
  hr: "Croatian",
  sr: "Serbian",
  sl: "Slovenian",
  sk: "Slovak",
  bg: "Bulgarian",
  lt: "Lithuanian",
  lv: "Latvian",
  et: "Estonian",
  is: "Icelandic",
  sq: "Albanian",
  mk: "Macedonian",
  be: "Belarusian",
  bs: "Bosnian",
  mt: "Maltese",
  ca: "Catalan",
  az: "Azerbaijani",
  kk: "Kazakh",
  uz: "Uzbek",
  mn: "Mongolian",
  sw: "Swahili",
});

export function languageEnglishName(code) {
  const c = normalizeLanguageCode(code) || "en";
  return LANGUAGE_ENGLISH_NAMES[c] || c;
}

/**
 * 发信语言优先级：红人最近一次回复语言 > bio 语言（置信度过线）> 英语。
 *
 * @param {{
 *   replyLanguage?: string|null,
 *   bioLanguage?: string|null,
 *   bioLanguageConfidence?: number|null,
 *   minBioConfidence?: number,
 * }} [input]
 * @returns {{language: string, source: "reply"|"bio"|"default", bioLanguage: string|null}}
 */
export function resolveCommunicationLanguage({
  replyLanguage = null,
  bioLanguage = null,
  bioLanguageConfidence = null,
  minBioConfidence = MIN_BIO_LANGUAGE_CONFIDENCE_FOR_OUTREACH,
} = {}) {
  const reply = normalizeLanguageCode(replyLanguage);
  if (reply) {
    return { language: reply, source: "reply", bioLanguage: normalizeLanguageCode(bioLanguage) };
  }

  const bio = normalizeLanguageCode(bioLanguage);
  const confidence = Number(bioLanguageConfidence);
  if (bio && Number.isFinite(confidence) && confidence >= minBioConfidence) {
    return { language: bio, source: "bio", bioLanguage: bio };
  }

  return { language: "en", source: "default", bioLanguage: bio };
}
