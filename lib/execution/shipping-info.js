import { queryTikTok } from "../db/mysql-tiktok.js";

export const SHIPPING_CONFIRMATION_STATUSES = {
  PROVIDED_PRE_APPROVAL: "provided_pre_approval",
  NEEDS_RECONFIRM: "needs_reconfirm",
  CONFIRMED_FOR_CAMPAIGN: "confirmed_for_campaign",
};

function parseJson(value) {
  if (value == null) return null;
  if (typeof value === "object") return value;
  if (typeof value !== "string") return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function clean(value) {
  const s = value == null ? "" : String(value).trim();
  return s || null;
}

function firstString(...values) {
  for (const value of values) {
    const s = clean(value);
    if (s) return s;
  }
  return null;
}

export function normalizeShippingInfo(raw = {}, extra = {}) {
  const info = parseJson(raw) || raw || {};
  if (!info || typeof info !== "object" || Array.isArray(info)) return null;
  const normalized = {
    fullName: firstString(info.fullName, info.name, info.recipientName),
    country: firstString(info.country),
    state: firstString(info.state, info.province, info.stateProvince),
    city: firstString(info.city),
    addressLine: firstString(
      info.addressLine,
      info.addressLine1,
      info.address,
      info.street
    ),
    postalCode: firstString(info.postalCode, info.zip, info.zipCode, info.postcode),
    phone: firstString(info.phone, info.telephone, info.tel, info.mobile, info.hp),
    ...(firstString(info.sku) ? { sku: firstString(info.sku) } : {}),
    ...(firstString(info.notes, info.note) ? { notes: firstString(info.notes, info.note) } : {}),
    ...extra,
  };
  for (const key of Object.keys(normalized)) {
    if (normalized[key] == null || normalized[key] === "") delete normalized[key];
  }
  return Object.keys(normalized).length ? normalized : null;
}

export function missingShippingFields(raw) {
  const info = normalizeShippingInfo(raw);
  const missing = [];
  if (!info?.fullName) missing.push("fullName");
  if (!info?.country) missing.push("country");
  if (!info?.city) missing.push("city");
  if (!info?.addressLine) missing.push("addressLine");
  if (!info?.postalCode) missing.push("postalCode");
  if (!info?.phone) missing.push("phone");
  return missing;
}

export function isCompleteShippingInfo(raw) {
  return missingShippingFields(raw).length === 0;
}

export async function getInfluencerShippingInfo(influencerId) {
  const id = clean(influencerId);
  if (!id) return null;
  const rows = await queryTikTok(
    `SELECT shipping_info FROM tiktok_influencer WHERE influencer_id = ? LIMIT 1`,
    [id]
  );
  return normalizeShippingInfo(parseJson(rows?.[0]?.shipping_info));
}

export async function upsertInfluencerShippingInfo({
  influencerId,
  shippingInfo,
  sourceMessageId = null,
  sourceCampaignId = null,
  source = "influencer_email",
  confirmedAt = null,
}) {
  const id = clean(influencerId);
  const normalized = normalizeShippingInfo(shippingInfo, {
    source,
    sourceMessageId: clean(sourceMessageId),
    sourceCampaignId: clean(sourceCampaignId),
    lastConfirmedAt: confirmedAt || new Date().toISOString(),
  });
  if (!id || !normalized || !isCompleteShippingInfo(normalized)) return null;

  await queryTikTok(
    `UPDATE tiktok_influencer
     SET shipping_info = ?, updated_at = CURRENT_TIMESTAMP
     WHERE influencer_id = ?`,
    [JSON.stringify(normalized), id]
  );
  return normalized;
}

export async function findLatestCompleteShippingInfoFromConversation(influencerId) {
  const id = clean(influencerId);
  if (!id) return null;
  const rows = await queryTikTok(
    `
    SELECT body_text, message_id, campaign_id, COALESCE(event_time, sent_at, created_at) AS at
    FROM tiktok_influencer_conversation_messages
    WHERE influencer_id = ?
      AND body_text IS NOT NULL
      AND (
        body_text REGEXP 'Name:|Address:|City/State:|Country:|Postal:|Zip:|Phone:|Telephone:|Hp:'
      )
    ORDER BY COALESCE(event_time, sent_at, created_at) DESC, id DESC
    LIMIT 50
    `,
    [id]
  );
  for (const row of rows || []) {
    const parsed = parseShippingInfoFromText(row.body_text);
    if (!parsed || !isCompleteShippingInfo(parsed)) continue;
    return normalizeShippingInfo(parsed, {
      source: "conversation_history",
      sourceMessageId: clean(row.message_id),
      sourceCampaignId: clean(row.campaign_id),
      lastConfirmedAt: row.at ? new Date(row.at).toISOString() : new Date().toISOString(),
    });
  }
  return null;
}

export async function resolveReusableShippingInfo(influencerId) {
  const saved = await getInfluencerShippingInfo(influencerId).catch(() => null);
  if (saved && isCompleteShippingInfo(saved)) return saved;
  const fromHistory = await findLatestCompleteShippingInfoFromConversation(influencerId).catch(
    () => null
  );
  if (fromHistory && isCompleteShippingInfo(fromHistory)) {
    await upsertInfluencerShippingInfo({
      influencerId,
      shippingInfo: fromHistory,
      sourceMessageId: fromHistory.sourceMessageId || null,
      sourceCampaignId: fromHistory.sourceCampaignId || null,
      source: "conversation_history",
      confirmedAt: fromHistory.lastConfirmedAt || null,
    }).catch(() => null);
    return fromHistory;
  }
  return null;
}

export function parseShippingInfoFromText(text) {
  const body = String(text || "");
  if (!body.trim()) return null;
  const lines = body
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const fields = {};
  const patterns = [
    ["fullName", /^(?:full\s*)?name\s*:\s*(.+)$/i],
    ["addressLine", /^(?:address|address\s*line|street)\s*:\s*(.+)$/i],
    ["cityState", /^(?:city\s*\/\s*state|city\s*,?\s*state)\s*:\s*(.+)$/i],
    ["city", /^city\s*:\s*(.+)$/i],
    ["state", /^(?:state|province|state\s*\/\s*province)\s*:\s*(.+)$/i],
    ["country", /^country\s*:\s*(.+)$/i],
    ["postalCode", /^(?:postal|post\s*\/?\s*zip\s*code|zip|zip\s*code|postcode)\s*:\s*(.+)$/i],
    ["phone", /^(?:phone|telephone|tel|mobile|hp)\s*:\s*(.+)$/i],
  ];
  for (const line of lines) {
    for (const [key, re] of patterns) {
      const m = line.match(re);
      if (!m) continue;
      fields[key] = m[1].trim();
      break;
    }
  }
  const labelRe =
    /\b(Name|Full Name|Address|Address Line|Street|City\/State|City|State|Province|State\/Province|Country|Postal|Post\/Zip Code|Zip|Zip Code|Postcode|Phone|Telephone|Tel|Mobile|Hp)\s*:/gi;
  const matches = [...body.matchAll(labelRe)];
  for (let i = 0; i < matches.length; i += 1) {
    const label = matches[i][1].toLowerCase().replace(/\s+/g, " ");
    const start = matches[i].index + matches[i][0].length;
    const end = i + 1 < matches.length ? matches[i + 1].index : body.length;
    const value = body.slice(start, end).replace(/\s+/g, " ").trim();
    if (!value) continue;
    if (label === "name" || label === "full name") fields.fullName ||= value;
    else if (label === "address" || label === "address line" || label === "street") fields.addressLine ||= value;
    else if (label === "city/state") {
      fields.city ||= value;
      fields.state ||= value;
    } else if (label === "city") fields.city ||= value;
    else if (label === "state" || label === "province" || label === "state/province") fields.state ||= value;
    else if (label === "country") fields.country ||= value;
    else if (
      label === "postal" ||
      label === "post/zip code" ||
      label === "zip" ||
      label === "zip code" ||
      label === "postcode"
    ) {
      fields.postalCode ||= value;
    } else if (
      label === "phone" ||
      label === "telephone" ||
      label === "tel" ||
      label === "mobile" ||
      label === "hp"
    ) {
      fields.phone ||= value;
    }
  }
  if (fields.cityState && !fields.city) {
    fields.city = fields.cityState;
    if (!fields.state) fields.state = fields.cityState;
  }
  return normalizeShippingInfo(fields);
}
