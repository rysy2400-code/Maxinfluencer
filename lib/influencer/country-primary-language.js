/**
 * 投放国家 ISO → 搜索关键词主语言（用于 LLM 生成检索词）
 */

import {
  normalizeRegionToZhLabels,
  resolveAllowedCountriesFromCampaign,
} from "./campaign-country-codes.js";

/** ISO 3166-1 alpha-2 → BCP-47 主语言简码 */
export const ISO_PRIMARY_LANGUAGE = Object.freeze({
  AD: "ca",
  AE: "ar",
  AF: "fa",
  AL: "sq",
  AM: "hy",
  AR: "es",
  AT: "de",
  AU: "en",
  AZ: "az",
  BA: "bs",
  BD: "bn",
  BE: "nl",
  BG: "bg",
  BH: "ar",
  BO: "es",
  BR: "pt",
  BY: "be",
  CA: "en",
  CH: "de",
  CL: "es",
  CN: "zh",
  CO: "es",
  CR: "es",
  CU: "es",
  CY: "el",
  CZ: "cs",
  DE: "de",
  DK: "da",
  DO: "es",
  DZ: "ar",
  EC: "es",
  EE: "et",
  EG: "ar",
  ES: "es",
  FI: "fi",
  FR: "fr",
  GB: "en",
  GE: "ka",
  GR: "el",
  GT: "es",
  HK: "zh",
  HN: "es",
  HR: "hr",
  HU: "hu",
  ID: "id",
  IE: "en",
  IL: "he",
  IN: "hi",
  IQ: "ar",
  IR: "fa",
  IS: "is",
  IT: "it",
  JM: "en",
  JO: "ar",
  JP: "ja",
  KE: "sw",
  KG: "ky",
  KH: "km",
  KR: "ko",
  KW: "ar",
  KZ: "kk",
  LA: "lo",
  LB: "ar",
  LK: "si",
  LT: "lt",
  LU: "fr",
  LV: "lv",
  MA: "ar",
  MD: "ro",
  MK: "mk",
  MM: "my",
  MN: "mn",
  MO: "zh",
  MT: "mt",
  MX: "es",
  MY: "ms",
  NG: "en",
  NL: "nl",
  NO: "no",
  NP: "ne",
  NZ: "en",
  OM: "ar",
  PA: "es",
  PE: "es",
  PH: "en",
  PK: "ur",
  PL: "pl",
  PR: "es",
  PT: "pt",
  PY: "es",
  QA: "ar",
  RO: "ro",
  RS: "sr",
  RU: "ru",
  SA: "ar",
  SE: "sv",
  SG: "en",
  SI: "sl",
  SK: "sk",
  TH: "th",
  TR: "tr",
  TW: "zh",
  TZ: "sw",
  UA: "uk",
  US: "en",
  UY: "es",
  UZ: "uz",
  VE: "es",
  VN: "vi",
  ZA: "en",
});

export const LANGUAGE_DISPLAY_NAMES = Object.freeze({
  en: "英语",
  de: "德语",
  fr: "法语",
  es: "西班牙语",
  zh: "中文",
  ja: "日语",
  ko: "韩语",
  id: "印尼语（Bahasa Indonesia）",
  th: "泰语",
  vi: "越南语",
  ms: "马来语",
  pt: "葡萄牙语",
  it: "意大利语",
  nl: "荷兰语",
  pl: "波兰语",
  tr: "土耳其语",
  ar: "阿拉伯语",
  ru: "俄语",
  hi: "印地语",
  he: "希伯来语",
  uk: "乌克兰语",
  cs: "捷克语",
  da: "丹麦语",
  fi: "芬兰语",
  no: "挪威语",
  sv: "瑞典语",
  hu: "匈牙利语",
  ro: "罗马尼亚语",
  el: "希腊语",
  bn: "孟加拉语",
  ur: "乌尔都语",
  fa: "波斯语",
  km: "高棉语",
  lo: "老挝语",
  my: "缅甸语",
  sw: "斯瓦希里语",
});

export function languageDisplayName(code) {
  const lang = String(code || "en").trim().toLowerCase() || "en";
  return LANGUAGE_DISPLAY_NAMES[lang] || lang;
}

/**
 * 从 campaign 投放地区解析关键词主语言。
 * 多国家时以列表中首个国家为主市场语言。
 * @param {object} campaignInfo
 */
export function resolvePrimaryLanguageFromCampaign(campaignInfo = {}) {
  const isos = resolveAllowedCountriesFromCampaign(campaignInfo);
  const targetCountryLabels = normalizeRegionToZhLabels(isos);

  if (!isos.length) {
    return {
      primaryLanguage: "en",
      languageName: languageDisplayName("en"),
      targetCountries: [],
      targetCountryLabels: [],
      allLanguages: ["en"],
      isMultiLanguage: false,
    };
  }

  const langs = isos.map((iso) => ISO_PRIMARY_LANGUAGE[iso] || "en");
  const uniqueLangs = [...new Set(langs)];
  const primaryIso = isos[0];
  const primaryLanguage = ISO_PRIMARY_LANGUAGE[primaryIso] || "en";

  return {
    primaryLanguage,
    languageName: languageDisplayName(primaryLanguage),
    targetCountries: isos,
    targetCountryLabels,
    primaryCountryLabel: targetCountryLabels[0] || primaryIso,
    allLanguages: uniqueLangs,
    isMultiLanguage: uniqueLangs.length > 1,
  };
}
