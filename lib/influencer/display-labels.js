/**
 * 展示用本地化标签：语言代码 → 中文；国家 ISO → 中文。
 */
import { ISO_TO_ZH_LABEL } from "./iso-country-registry.js";

/** ISO 639-1（含平台常见非标准码）→ 中文名 */
export const LANGUAGE_ZH = Object.freeze({
  en: "英语",
  un: "未知",
  und: "未知",
  zh: "中文",
  ja: "日语",
  ko: "韩语",
  es: "西班牙语",
  pt: "葡萄牙语",
  fr: "法语",
  de: "德语",
  it: "意大利语",
  nl: "荷兰语",
  ru: "俄语",
  ar: "阿拉伯语",
  hi: "印地语",
  ur: "乌尔都语",
  bn: "孟加拉语",
  id: "印尼语",
  ms: "马来语",
  tl: "菲律宾语",
  vi: "越南语",
  th: "泰语",
  tr: "土耳其语",
  pl: "波兰语",
  uk: "乌克兰语",
  ro: "罗马尼亚语",
  el: "希腊语",
  he: "希伯来语",
  sh: "塞尔维亚-克罗地亚语",
  sr: "塞尔维亚语",
  hr: "克罗地亚语",
  sv: "瑞典语",
  da: "丹麦语",
  no: "挪威语",
  fi: "芬兰语",
  cs: "捷克语",
  hu: "匈牙利语",
  my: "缅甸语",
  km: "高棉语",
  lo: "老挝语",
  si: "僧伽罗语",
  ta: "泰米尔语",
  te: "泰卢固语",
  ne: "尼泊尔语",
  fa: "波斯语",
  sw: "斯瓦希里语",
  ga: "爱尔兰语",
  ig: "伊博语",
});

export function languageZh(code) {
  const key = String(code || "").trim().toLowerCase();
  return LANGUAGE_ZH[key] || key || "未知";
}

export function countryZh(code) {
  const key = String(code || "").trim().toUpperCase();
  if (!key || key === "COUNTRY_UNKNOWN" || key === "UNKNOWN" || key === "-") return null;
  return ISO_TO_ZH_LABEL[key] || key;
}

/** 语言分布 → "英语 85% · 未知 15%"（默认取前三） */
export function formatLanguageMix(mix, { top = 3 } = {}) {
  const entries = Object.entries(mix || {})
    .filter(([, v]) => Number(v) > 0)
    .sort((a, b) => Number(b[1]) - Number(a[1]))
    .slice(0, top);
  if (!entries.length) return null;
  return entries
    .map(([k, v]) => `${languageZh(k)} ${Math.round(Number(v) * 100)}%`)
    .join(" · ");
}

export function formatPercent(v) {
  if (v == null || v === "") return "—";
  const n = Number(v);
  if (!Number.isFinite(n)) return "—";
  return `${Math.round(n * 100)}%`;
}
