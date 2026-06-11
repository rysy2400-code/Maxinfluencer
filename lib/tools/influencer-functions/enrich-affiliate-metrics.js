/**
 * 从 TikTok Affiliate Partner 后台拉取红人 GMV / Units sold（每次 enrich 实时调用，无缓存）
 * 依赖 9222 Chrome 已登录 partner.us.tiktokshop.com
 */

const FIND_PATH =
  "/api/v1/oec/affiliate/creator/marketplace/4partner/find";

function affiliateEnabled() {
  const v = String(process.env.AFFILIATE_GMV_ENRICH ?? "true").trim().toLowerCase();
  return v !== "0" && v !== "false" && v !== "no";
}

function resolvePartnerId() {
  return (
    process.env.AFFILIATE_PARTNER_ID ||
    process.env.TIKTOK_AFFILIATE_PARTNER_ID ||
    "8647245523056104235"
  );
}

function buildFindUrl() {
  const params = new URLSearchParams({
    user_language: "en",
    partner_id: resolvePartnerId(),
    aid: process.env.AFFILIATE_AID || "359713",
    app_name: "i18n_ecom_alliance",
    device_id: "0",
    device_platform: "web",
    cookie_enabled: "true",
  });
  return `https://partner.us.tiktokshop.com${FIND_PATH}?${params.toString()}`;
}

/** @param {unknown} node */
export function unwrapAffiliateField(node) {
  if (node == null) return null;
  if (typeof node !== "object") return node;
  if (Array.isArray(node)) return node;
  if ("value" in node) return unwrapAffiliateField(node.value);
  return node;
}

/** @param {unknown} wrapped */
function isAffiliateFieldAuthorized(wrapped) {
  if (wrapped == null || typeof wrapped !== "object" || Array.isArray(wrapped)) {
    return true;
  }
  if ("is_authorized" in wrapped && wrapped.is_authorized === false) return false;
  if ("status" in wrapped && wrapped.status !== 0 && wrapped.status != null) {
    return false;
  }
  return true;
}

/** @param {unknown} wrapped */
function parseAuthorizedNumber(wrapped) {
  if (!isAffiliateFieldAuthorized(wrapped)) return null;
  const raw = unwrapAffiliateField(wrapped);
  if (raw == null || raw === "") return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/** @param {unknown} wrapped */
function parseAuthorizedDisplay(wrapped) {
  if (!isAffiliateFieldAuthorized(wrapped)) return null;
  const raw =
    wrapped != null &&
    typeof wrapped === "object" &&
    !Array.isArray(wrapped) &&
    "value" in wrapped
      ? wrapped.value
      : unwrapAffiliateField(wrapped);
  if (raw == null || raw === "") return null;
  const s = String(raw).trim();
  return s || null;
}

/** @param {object} hit */
function parseGmvFromHit(hit) {
  const exact = parseGmv(hit?.med_gmv_revenue);
  if (exact.gmv != null || exact.gmvDisplay) return exact;
  const rangeDisplay = parseAuthorizedDisplay(hit?.med_gmv_revenue_range);
  if (rangeDisplay) return { gmv: null, gmvDisplay: rangeDisplay };
  return { gmv: null, gmvDisplay: null };
}

/** @param {object} hit */
function parseUnitsSoldFromHit(hit) {
  const exact = parseAuthorizedNumber(hit?.units_sold);
  if (exact != null) return { unitsSold: exact, unitsSoldDisplay: String(exact) };
  const rangeDisplay = parseAuthorizedDisplay(hit?.units_sold_range);
  if (rangeDisplay) return { unitsSold: null, unitsSoldDisplay: rangeDisplay };
  return { unitsSold: null, unitsSoldDisplay: null };
}

/** @param {unknown} wrapped */
function parseGmv(wrapped) {
  if (!isAffiliateFieldAuthorized(wrapped)) return { gmv: null, gmvDisplay: null };

  const inner =
    wrapped != null && typeof wrapped === "object" && !Array.isArray(wrapped) && "value" in wrapped
      ? wrapped.value
      : wrapped;

  if (inner != null && typeof inner === "object" && !Array.isArray(inner)) {
    const numeric = inner.value != null ? Number(inner.value) : NaN;
    const gmv = Number.isFinite(numeric) ? numeric : null;
    const gmvDisplay =
      typeof inner.format === "string" && inner.format.trim()
        ? inner.format.trim()
        : gmv != null
          ? `$${gmv.toLocaleString("en-US", { maximumFractionDigits: 0 })}`
          : null;
    return { gmv, gmvDisplay };
  }

  const raw = inner ?? unwrapAffiliateField(wrapped);
  if (raw == null || raw === "") return { gmv: null, gmvDisplay: null };

  const n = Number(raw);
  if (!Number.isFinite(n)) return { gmv: null, gmvDisplay: null };
  return {
    gmv: n,
    gmvDisplay: `$${n.toLocaleString("en-US", { maximumFractionDigits: 0 })}`,
  };
}

/**
 * @param {import('playwright').BrowserContext} context
 * @param {string} username
 * @param {{ market?: number }} [options]
 */
export async function fetchAffiliateMetricsByUsername(context, username, options = {}) {
  const handle = String(username || "").replace(/^@/, "").trim();
  const empty = {
    ok: false,
    gmv: null,
    gmvDisplay: null,
    unitsSold: null,
    unitsSoldDisplay: null,
    creatorOecuid: null,
    gmvSource: null,
    gmvUpdatedAt: null,
    affiliateMetrics: null,
    reason: "missing_username",
  };

  if (!affiliateEnabled()) {
    return { ...empty, reason: "disabled" };
  }
  if (!handle) {
    return empty;
  }
  if (!context?.request) {
    return { ...empty, reason: "no_request_context" };
  }

  const timeoutMs = Math.max(
    5000,
    Number(process.env.AFFILIATE_FETCH_TIMEOUT_MS) || 20000
  );

  try {
    const response = await context.request.post(buildFindUrl(), {
      data: {
        query: handle,
        query_type: 1,
        pagination: { size: 12, page: 0 },
        filter_params: {},
        algorithm: 1,
      },
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/plain, */*",
        origin: "https://partner.us.tiktokshop.com",
        referer: `https://partner.us.tiktokshop.com/affiliate-cmp/creator?market=${
          options.market ?? process.env.AFFILIATE_MARKET ?? 100
        }`,
      },
      timeout: timeoutMs,
    });

    if (response.status() === 401 || response.status() === 403) {
      return { ...empty, reason: "login_required" };
    }

    let json;
    try {
      json = await response.json();
    } catch {
      return { ...empty, reason: "invalid_json" };
    }

    const code = json?.code;
    if (code !== 0 && code !== "0") {
      const msg = String(json?.message || json?.msg || "").toLowerCase();
      if (msg.includes("login") || msg.includes("auth") || code === 98001001) {
        return { ...empty, reason: "login_required" };
      }
      return { ...empty, reason: `api_error_${code}` };
    }

    const list = json?.creator_profile_list;
    if (!Array.isArray(list) || list.length === 0) {
      return { ...empty, reason: "not_found" };
    }

    const hit =
      list.find(
        (item) =>
          String(unwrapAffiliateField(item?.handle) || "").toLowerCase() ===
          handle.toLowerCase()
      ) || null;

    if (!hit) {
      return { ...empty, reason: "handle_not_matched" };
    }

    const { gmv, gmvDisplay } = parseGmvFromHit(hit);
    const { unitsSold, unitsSoldDisplay } = parseUnitsSoldFromHit(hit);
    const creatorOecuid = unwrapAffiliateField(hit.creator_oecuid);

    const hasCommerceData =
      gmv != null || gmvDisplay != null || unitsSold != null || unitsSoldDisplay != null;
    const now = new Date().toISOString();

    return {
      ok: hasCommerceData,
      gmv,
      gmvDisplay,
      unitsSold,
      unitsSoldDisplay,
      creatorOecuid: creatorOecuid ? String(creatorOecuid) : null,
      gmvSource: hasCommerceData ? "tiktok_affiliate_partner" : null,
      gmvUpdatedAt: hasCommerceData ? now : null,
      gmvPeriodDays: 30,
      gmvCurrency: "USD",
      affiliateMetrics: {
        creatorOecuid: creatorOecuid ? String(creatorOecuid) : null,
        handle: unwrapAffiliateField(hit.handle),
        nickname: unwrapAffiliateField(hit.nickname),
        gmv,
        gmvDisplay,
        unitsSold,
        unitsSoldDisplay,
        followerCnt: parseAuthorizedNumber(hit.follower_cnt),
        ecVideoAvgViewCnt: parseAuthorizedNumber(hit.ec_video_avg_view_cnt),
        industryGroups: unwrapAffiliateField(hit.industry_groups),
        selectionRegion: unwrapAffiliateField(hit.selection_region),
        source: "tiktok_affiliate_partner_find",
        fetchedAt: now,
      },
      reason: hasCommerceData ? null : "unauthorized_or_empty",
    };
  } catch (err) {
    return {
      ...empty,
      reason: err?.message?.includes("Timeout")
        ? "timeout"
        : "request_failed",
    };
  }
}

/**
 * 合并 affiliate 结果到 enrich 记录（失败不抛错）
 * @param {object} mergedRecord
 * @param {Awaited<ReturnType<typeof fetchAffiliateMetricsByUsername>>} affiliate
 */
export function applyAffiliateMetricsToRecord(mergedRecord, affiliate) {
  if (!mergedRecord || !affiliate) return mergedRecord;

  if (affiliate.gmv != null || affiliate.gmvDisplay) {
    if (affiliate.gmv != null) mergedRecord.gmv = affiliate.gmv;
    if (affiliate.gmvDisplay) mergedRecord.gmvDisplay = affiliate.gmvDisplay;
    mergedRecord.gmvSource = affiliate.gmvSource;
    mergedRecord.gmvUpdatedAt = affiliate.gmvUpdatedAt;
    mergedRecord.gmvPeriodDays = affiliate.gmvPeriodDays ?? 30;
    mergedRecord.gmvCurrency = affiliate.gmvCurrency ?? "USD";
  }
  if (affiliate.unitsSold != null) {
    mergedRecord.unitsSold = affiliate.unitsSold;
  }
  if (affiliate.unitsSoldDisplay) {
    mergedRecord.unitsSoldDisplay = affiliate.unitsSoldDisplay;
  }
  if (affiliate.creatorOecuid) {
    mergedRecord.affiliateCreatorOecuid = affiliate.creatorOecuid;
  }
  if (affiliate.affiliateMetrics) {
    mergedRecord.affiliateMetrics = affiliate.affiliateMetrics;
  }

  return mergedRecord;
}
