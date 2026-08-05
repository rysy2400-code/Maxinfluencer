/**
 * Campaign 投放地区 ↔ 平台红人国家（ISO 3166-1 alpha-2）映射。
 * 展示层用中文国家名（如「美国」）；过滤与 DB 使用 ISO（US、DE）。
 */

import { ISO_TO_ZH_LABEL, LABEL_TO_ISO } from "./iso-country-registry.js";

function flattenRegionInputs(raw) {
  if (raw == null) return [];
  if (Array.isArray(raw)) {
    return raw.flatMap((item) => flattenRegionInputs(item));
  }
  return [raw];
}

function lookupIso(token) {
  if (token == null) return null;
  const s = String(token).trim();
  if (!s) return null;

  const lower = s.toLowerCase();
  let iso = LABEL_TO_ISO[lower] ?? LABEL_TO_ISO[s] ?? null;

  if (!iso && /^[A-Za-z]{2}$/.test(s)) {
    iso = s.toUpperCase();
  }

  return iso && ISO_TO_ZH_LABEL[iso] ? iso : null;
}

/**
 * 将 region / countries 等任意输入规范为 ISO 2 列表（去重、大写）。
 * @param {unknown} raw - string | string[] | campaignInfo 片段
 * @returns {string[]}
 */
export function normalizeAllowedCountries(raw) {
  const parts = flattenRegionInputs(raw);
  const out = [];
  const seen = new Set();

  for (const item of parts) {
    const iso = lookupIso(item);
    if (!iso) continue;
    if (seen.has(iso)) continue;
    seen.add(iso);
    out.push(iso);
  }

  return out;
}

/**
 * 将任意地区输入规范为中文展示名列表（与 ISO 一一对应）。
 * @param {unknown} raw
 * @returns {string[]}
 */
export function normalizeRegionToZhLabels(raw) {
  return normalizeAllowedCountries(raw).map(
    (iso) => ISO_TO_ZH_LABEL[iso] || iso
  );
}

/**
 * 判断是否为可识别的国家/地区名（中文、英文或 ISO 2）。
 * @param {unknown} region
 * @returns {boolean}
 */
export function isRecognizedCountryRegion(region) {
  return normalizeAllowedCountries(region).length > 0;
}

/**
 * 从 campaignInfo 解析允许的国家 ISO 列表。
 * @param {object} campaignInfo
 * @param {string[]} [explicitCountries] - worker 传入的 countries 参数
 */
export function resolveAllowedCountriesFromCampaign(
  campaignInfo = {},
  explicitCountries = null
) {
  const fromExplicit = normalizeAllowedCountries(explicitCountries);
  if (fromExplicit.length) return fromExplicit;

  const fromInfoCountries = normalizeAllowedCountries(campaignInfo?.countries);
  if (fromInfoCountries.length) return fromInfoCountries;

  return normalizeAllowedCountries(campaignInfo?.region);
}

/**
 * 将 TikTok locationCreated、IG「账户所在地」、YT About 国家等规范为 ISO 2。
 * @param {unknown} raw
 * @returns {string|null}
 */
export function normalizeInfluencerCountryToIso(raw) {
  if (raw == null) return null;
  const list = normalizeAllowedCountries(raw);
  if (list.length) return list[0];

  const s = String(raw).trim();
  if (!s) return null;
  return lookupIso(s);
}

/**
 * @param {string|null|undefined} publishCountry - ISO 或中文/英文国家名
 * @param {string[]} allowedIso - 已规范化的 ISO 列表
 */
export function countryMatchesPublishLocation(publishCountry, allowedIso) {
  const allowed = normalizeAllowedCountries(allowedIso);
  if (!allowed.length) return true;
  const pub = normalizeInfluencerCountryToIso(publishCountry);
  if (!pub) return false;
  return allowed.includes(pub);
}

/** ISO → 中文展示（工作实况/日志可选） */
export function isoCountriesToDisplayLabels(isoList) {
  return normalizeAllowedCountries(isoList).map(
    (iso) => ISO_TO_ZH_LABEL[iso] || iso
  );
}

/** 展示层视为“国家未知”的哨兵值（如 INS 链路写入的 country_unknown） */
const UNKNOWN_COUNTRY_DISPLAY_VALUES = new Set([
  "country_unknown",
  "unknown_country",
  "unknown country",
  "unknown",
  "n/a",
  "未知",
]);

/**
 * 判断原始国家值是否应视为“未知”（不参与展示，展示为 —）。
 * @param {unknown} raw
 * @returns {boolean}
 */
export function isUnknownCountryValue(raw) {
  if (raw == null) return true;
  const s = String(raw).trim().toLowerCase();
  if (!s) return true;
  return UNKNOWN_COUNTRY_DISPLAY_VALUES.has(s);
}

/**
 * 红人 video_publish_country 等：ISO / 中英文 → 中文展示名；
 * 无法识别则原样返回，已知“未知”哨兵值返回 null。
 * @param {unknown} raw
 * @returns {string|null}
 */
export function formatCountryForDisplay(raw) {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (!s) return null;
  const iso = normalizeInfluencerCountryToIso(s);
  if (iso) return ISO_TO_ZH_LABEL[iso] || iso;
  if (isUnknownCountryValue(s)) return null;
  return s;
}

/**
 * 发布落库前：region 统一为中文展示名，写入 countries ISO。
 * @param {object|null} campaignInfo
 * @returns {object|null}
 */
export function enrichCampaignInfoCountryFields(campaignInfo) {
  if (!campaignInfo || typeof campaignInfo !== "object") return campaignInfo;

  const countries = resolveAllowedCountriesFromCampaign(campaignInfo, null);
  if (!countries.length) return { ...campaignInfo };

  const regionZh = normalizeRegionToZhLabels(
    campaignInfo.region ?? countries
  );

  return {
    ...campaignInfo,
    region: regionZh.length ? regionZh : campaignInfo.region,
    countries,
  };
}

/** tiktok_campaign.region 标量列：取首个 ISO */
export function primaryRegionIsoFromCampaignInfo(campaignInfo) {
  const list = resolveAllowedCountriesFromCampaign(campaignInfo, null);
  return list[0] || "US";
}

export { ISO_TO_ZH_LABEL };
