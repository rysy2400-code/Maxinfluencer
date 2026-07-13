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
