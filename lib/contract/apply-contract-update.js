/**
 * 把双方达成一致的合同条款更新写入执行表，并自动生成 / 发送新版合同。
 *
 * contractUpdate 结构（由 agent 在「条款类特殊请求闭合」时给出）：
 * {
 *   sourceSpecialRequestId?: string,
 *   additionalTerms?: string[],                  // 不冲突的新增条款（正式英文，写入 4. Additional Terms）
 *   sectionOverrides?: Record<string, string>,   // 与固定条款冲突时的替换文本（直接改固定条款本身）
 *   changeSummary?: string                       // 一句话说明本次更新（用于重发邮件）
 * }
 *
 * 幂等：同一 sourceSpecialRequestId 只应用一次。
 */
import { getExecutionRow } from "../db/campaign-dao.js";
import { queryTikTok } from "../db/mysql-tiktok.js";
import { enqueueContractEmail } from "./enqueue-contract-email.js";

/** 允许被覆盖的固定条款键 */
export const CONTRACT_SECTION_KEYS = [
  "deliverables",
  "fee",
  "paymentMethod",
  "paymentTiming",
  "acceptance",
  "general",
];

function normalizeAdditionalTerms(list) {
  if (!Array.isArray(list)) return [];
  return list
    .map((t) => (typeof t === "string" ? t : t?.text))
    .map((t) => String(t ?? "").trim())
    .filter(Boolean);
}

function normalizeSectionOverrides(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out = {};
  for (const [k, v] of Object.entries(raw)) {
    if (!CONTRACT_SECTION_KEYS.includes(k)) continue;
    if (typeof v === "string" && v.trim()) out[k] = v.trim();
  }
  return out;
}

/**
 * 纯函数：根据现有 last_event 与 contractUpdate 计算下一版合同状态。
 * 便于单测，且让 DB 写入逻辑保持单一。
 *
 * @param {object} lastEvent
 * @param {object} contractUpdate
 * @returns {{ applied: boolean, reason?: string, next?: object, revision?: number, additionalTermsCount?: number, sectionOverrideKeys?: string[] }}
 */
export function computeContractUpdate(lastEvent, contractUpdate) {
  const prev = lastEvent && typeof lastEvent === "object" ? lastEvent : {};
  const extraTerms = normalizeAdditionalTerms(contractUpdate?.additionalTerms);
  const overrides = normalizeSectionOverrides(contractUpdate?.sectionOverrides);
  if (!extraTerms.length && !Object.keys(overrides).length) {
    return { applied: false, reason: "empty_contract_update" };
  }

  const sourceId = contractUpdate?.sourceSpecialRequestId || null;
  const appliedIds = Array.isArray(prev.contractAppliedUpdates) ? prev.contractAppliedUpdates : [];
  if (sourceId && appliedIds.some((x) => x?.sourceSpecialRequestId === sourceId)) {
    return { applied: false, reason: "already_applied" };
  }

  const existingTerms = Array.isArray(prev.contractAdditionalTerms) ? prev.contractAdditionalTerms : [];
  const seen = new Set(
    existingTerms.map((e) => String(e?.text ?? e).trim().toLowerCase()).filter(Boolean)
  );
  const mergedTerms = [...existingTerms];
  const now = new Date().toISOString();
  for (const t of extraTerms) {
    const k = t.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    mergedTerms.push({ text: t, sourceSpecialRequestId: sourceId, agreedAt: now });
  }

  const prevOverrides =
    prev.contractSectionOverrides && typeof prev.contractSectionOverrides === "object"
      ? prev.contractSectionOverrides
      : {};
  const mergedOverrides = { ...prevOverrides, ...overrides };

  const prevRevision = Number(prev.contractRevision);
  const nextRevision = (Number.isFinite(prevRevision) && prevRevision >= 1 ? prevRevision : 1) + 1;
  const changeSummary = String(contractUpdate?.changeSummary || "").trim() || null;

  const next = {
    ...prev,
    contractAdditionalTerms: mergedTerms,
    contractSectionOverrides: mergedOverrides,
    contractRevision: nextRevision,
    ...(changeSummary ? { contractChangeSummary: changeSummary } : {}),
    contractAppliedUpdates: [
      ...appliedIds,
      {
        sourceSpecialRequestId: sourceId,
        appliedAt: now,
        revision: nextRevision,
        additionalTermsCount: extraTerms.length,
        sectionOverrideKeys: Object.keys(overrides),
      },
    ],
  };

  return {
    applied: true,
    next,
    revision: nextRevision,
    additionalTermsCount: extraTerms.length,
    sectionOverrideKeys: Object.keys(overrides),
    changeSummary,
  };
}

/**
 * @param {{
 *   campaignId: string,
 *   influencerHandle?: string|null,
 *   platformInfluencerId?: string|null,
 *   contractUpdate: object,
 *   autoSend?: boolean,
 * }} opts
 */
export async function applyContractUpdate({
  campaignId,
  influencerHandle = null,
  platformInfluencerId = null,
  contractUpdate,
  autoSend = true,
}) {
  const cid = String(campaignId || "").trim();
  if (!cid) throw new Error("applyContractUpdate 缺少 campaignId");

  const handle = String(influencerHandle || "")
    .replace(/^@/, "")
    .trim();
  const key = handle || (platformInfluencerId != null ? String(platformInfluencerId).trim() : "");
  if (!key) throw new Error("applyContractUpdate 需要 influencerHandle 或 platformInfluencerId");

  const exec = await getExecutionRow(cid, key);
  if (!exec) throw new Error(`applyContractUpdate 未找到执行记录：campaign=${cid} influencer=${key}`);

  const computed = computeContractUpdate(exec.lastEvent || {}, contractUpdate);
  if (!computed.applied) {
    return { applied: false, reason: computed.reason };
  }
  const nextRevision = computed.revision;
  const changeSummary = computed.changeSummary || null;

  await queryTikTok(
    `UPDATE tiktok_campaign_execution SET last_event = ? WHERE campaign_id = ? AND tiktok_username = ?`,
    [JSON.stringify(computed.next), cid, String(exec.tiktok_username || handle)]
  );

  let enqueuedEventId = null;
  if (autoSend) {
    const enq = await enqueueContractEmail({
      campaignId: cid,
      influencerHandle: exec.tiktok_username || handle,
      platformInfluencerId: exec.influencer_id || platformInfluencerId || null,
      contract: changeSummary ? { changeSummary } : null,
    });
    enqueuedEventId = enq?.eventId ?? null;
  }

  return {
    applied: true,
    revision: nextRevision,
    additionalTermsCount: computed.additionalTermsCount,
    sectionOverrideKeys: computed.sectionOverrideKeys,
    changeSummary,
    enqueuedEventId,
  };
}
