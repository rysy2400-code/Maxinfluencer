/**
 * Campaign 投放地区 ↔ TikTok locationCreated（ISO 2）映射。
 * 展示层可继续用「美国」；过滤与 DB 使用 ISO（US、DE）。
 */

const LABEL_TO_ISO = {
  美国: "US",
  美國: "US",
  "united states": "US",
  "united states of america": "US",
  usa: "US",
  us: "US",
  德国: "DE",
  德國: "DE",
  germany: "DE",
  de: "DE",
  英国: "GB",
  英國: "GB",
  "united kingdom": "GB",
  "great britain": "GB",
  uk: "GB",
  gb: "GB",
  england: "GB",
};

const ISO_TO_LABEL = {
  US: "美国",
  DE: "德国",
  GB: "英国",
};

function flattenRegionInputs(raw) {
  if (raw == null) return [];
  if (Array.isArray(raw)) {
    return raw.flatMap((item) => flattenRegionInputs(item));
  }
  return [raw];
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
    if (item == null) continue;
    const s = String(item).trim();
    if (!s) continue;

    const lower = s.toLowerCase();
    let iso = LABEL_TO_ISO[lower] ?? LABEL_TO_ISO[s] ?? null;

    if (!iso && /^[A-Za-z]{2}$/.test(s)) {
      iso = s.toUpperCase();
    }

    if (!iso) continue;
    if (seen.has(iso)) continue;
    seen.add(iso);
    out.push(iso);
  }

  return out;
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
  const s = String(raw).trim();
  if (!s) return null;

  const fromList = normalizeAllowedCountries(s);
  if (fromList.length) return fromList[0];

  const lower = s.toLowerCase();
  if (LABEL_TO_ISO[lower]) return LABEL_TO_ISO[lower];
  if (LABEL_TO_ISO[s]) return LABEL_TO_ISO[s];

  if (/^[A-Za-z]{2}$/.test(s)) return s.toUpperCase();

  return null;
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
  return normalizeAllowedCountries(isoList).map((iso) => ISO_TO_LABEL[iso] || iso);
}

/**
 * 发布落库前：保留 region 中文展示，写入 countries ISO。
 * @param {object|null} campaignInfo
 * @returns {object|null}
 */
export function enrichCampaignInfoCountryFields(campaignInfo) {
  if (!campaignInfo || typeof campaignInfo !== "object") return campaignInfo;

  const countries = resolveAllowedCountriesFromCampaign(campaignInfo, null);
  if (!countries.length) return { ...campaignInfo };

  return {
    ...campaignInfo,
    countries,
  };
}

/** tiktok_campaign.region 标量列：取首个 ISO */
export function primaryRegionIsoFromCampaignInfo(campaignInfo) {
  const list = resolveAllowedCountriesFromCampaign(campaignInfo, null);
  return list[0] || "US";
}
