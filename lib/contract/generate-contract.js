/**
 * 生成 Collaboration Agreement PDF（Binfluencer <-> Creator）。
 *
 * 数据来源：
 * - Campaign：tiktok_campaign（品牌名 / 产品链接 / deliverables 字段 / 发布窗口 / 平台）
 * - 执行表：tiktok_campaign_execution（flat_fee / currency，统一以此为准）
 * - 红人主档：tiktok_influencer（显示名 / handle / 邮箱 / 主页链接）
 * - 对话记忆：tiktok_influencer_conversation_messages（用于生成 Deliverables + 时间线）
 */
import fs from "fs";
import path from "path";
import { getCampaignCoreById, getExecutionRow } from "../db/campaign-dao.js";
import { getInfluencerById } from "../db/influencer-dao.js";
import { queryTikTok } from "../db/mysql-tiktok.js";
import { loadConversationHistoryForInfluencer } from "../agents/influencer-agent.js";
import { parseCampaignPlatforms } from "../influencer/resolve-campaign-platforms.js";
import { normalizeDeliverablesText } from "../campaign/deliverables.js";
import { buildContractNo, formatContractDate, formatTimestampCompact } from "./contract-number.js";
import { generateContractDeliverablesText } from "./contract-deliverables.js";
import { renderCollaborationContractPdf } from "./contract-pdf.js";
import { buildContractClauses } from "./contract-clauses.js";

export const AGENCY_NAME = "Binfluencer";
export const AGENCY_WEBSITE = "https://www.binfluencer.xyz";
export const AGENCY_SIGNATORY = "Bin";
export const AGENCY_TITLE = "Founder";

export const CONTRACTS_STORAGE_DIR = path.join("storage", "contracts");

/**
 * @param {string} storageKey 形如 storage/contracts/<influencerId>/<no>.pdf
 */
export function resolveContractAbsPath(storageKey) {
  const key = String(storageKey || "").trim();
  if (!key) throw new Error("resolveContractAbsPath 缺少 storageKey");
  return path.join(process.cwd(), key);
}

/**
 * 「品牌方点确认同意」那一刻的报价快照。
 * 来源：tiktok_advertiser_balance_ledger（type=quote_approve）
 * - influencer_amount：红人合作费（已扣平台服务费的净额）
 * - currency：当时币种
 * - created_at：品牌点「确认同意」的时间（合同日期取此值）
 */
export async function resolveApprovedQuoteSnapshot({
  campaignId,
  influencerHandle,
  influencerId,
}) {
  const keys = [influencerHandle, influencerId]
    .map((v) => (v == null ? "" : String(v).trim()))
    .filter(Boolean);
  if (!keys.length) return null;
  const placeholders = keys.map(() => "?").join(",");
  const rows = await queryTikTok(
    `SELECT influencer_amount, currency, created_at
       FROM tiktok_advertiser_balance_ledger
      WHERE type = 'quote_approve'
        AND campaign_id = ?
        AND influencer_id IN (${placeholders})
      ORDER BY id DESC
      LIMIT 1`,
    [campaignId, ...keys]
  );
  if (!rows?.length) return null;
  const r = rows[0];
  const amount = Math.abs(Number(r.influencer_amount));
  if (!Number.isFinite(amount) || amount <= 0) return null;
  return {
    feeAmount: amount,
    currency: String(r.currency || "USD").trim().toUpperCase() || "USD",
    approvedAt: r.created_at ? new Date(r.created_at) : null,
  };
}

/**
 * 归一化协商新增条款（Additional Terms）：支持 string / { text } 混合数组
 */
function normalizeAdditionalTerms(list) {
  if (!Array.isArray(list)) return [];
  return list
    .map((t) => (typeof t === "string" ? t : t?.text))
    .map((t) => String(t ?? "").trim())
    .filter(Boolean);
}

/** 归一化固定条款覆盖（直接改固定条款本身）：{ paymentTiming: "..." } */
function normalizeSectionOverrides(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out = {};
  for (const [k, v] of Object.entries(raw)) {
    if (typeof v === "string" && v.trim()) out[k] = v.trim();
  }
  return out;
}

/**
 * @param {{
 *   campaignId: string,
 *   influencerHandle?: string|null,
 *   influencerId?: string|null,
 *   contractNo?: string|null,
 *   revision?: number|null,
 *   additionalTerms?: Array<string|{text:string}>|null,
 *   sectionOverrides?: Record<string,string>|null,
 *   date?: Date,
 * }} opts
 */
export async function generateContractForExecution({
  campaignId,
  influencerHandle = null,
  influencerId = null,
  contractNo = null,
  revision = null,
  additionalTerms = null,
  sectionOverrides = null,
  date = new Date(),
}) {
  const cid = String(campaignId || "").trim();
  if (!cid) throw new Error("generateContractForExecution: 缺少 campaignId");

  const campaign = await getCampaignCoreById(cid);
  if (!campaign) throw new Error(`未找到 campaign: ${cid}`);

  const handle = String(influencerHandle || "")
    .replace(/^@/, "")
    .trim();
  const lookupKey = handle || (influencerId != null ? String(influencerId).trim() : "");
  if (!lookupKey) {
    throw new Error("generateContractForExecution: 需要 influencerHandle 或 influencerId");
  }

  const execution = await getExecutionRow(cid, lookupKey);
  if (!execution) {
    throw new Error(`未找到执行记录: campaign=${cid} influencer=${lookupKey}`);
  }

  const platformInfluencerId = String(execution.influencer_id || influencerId || "").trim() || null;
  const creatorHandle =
    String(execution.tiktok_username || handle || "").replace(/^@/, "").trim() || null;

  const influencer = platformInfluencerId ? await getInfluencerById(platformInfluencerId) : null;

  const history = platformInfluencerId
    ? await loadConversationHistoryForInfluencer(platformInfluencerId, 50)
    : [];

  // 金额/币种/合同日期：优先取「品牌点确认同意」那一刻的扣款快照
  const approvedSnapshot = await resolveApprovedQuoteSnapshot({
    campaignId: cid,
    influencerHandle: creatorHandle,
    influencerId: platformInfluencerId,
  });

  const feeAmount = approvedSnapshot?.feeAmount ?? Number(execution.flat_fee);
  if (!Number.isFinite(feeAmount) || feeAmount <= 0) {
    throw new Error(
      `金额缺失或非法（campaign=${cid} influencer=${creatorHandle || lookupKey}）：ledger=${approvedSnapshot?.feeAmount} execution.flat_fee=${execution.flat_fee}`
    );
  }
  const currency =
    approvedSnapshot?.currency ||
    String(execution.currency || "USD").trim().toUpperCase() ||
    "USD";

  if (currency !== "USD") {
    console.warn(
      `[generateContract] 非 USD 结算（campaign=${cid} influencer=${creatorHandle || lookupKey}，币种=${currency}）；合同将按扣款快照的原币种生成。`
    );
  }

  const contractDateObj =
    approvedSnapshot?.approvedAt instanceof Date &&
    !Number.isNaN(approvedSnapshot.approvedAt.getTime())
      ? approvedSnapshot.approvedAt
      : date;

  const campaignInfo = campaign.campaignInfo || {};
  const brandName = campaign.productInfo?.brandName || campaign.productInfo?.productName || null;
  const productName = campaign.productInfo?.productName || campaign.productInfo?.product || null;
  const productLink = String(campaign.productInfo?.productLink || "").trim() || null;

  // 硬性阻断：campaign 没有交付结果配置时不得生成合同（合同写错代价高）
  const deliverablesField = normalizeDeliverablesText(campaignInfo.deliverables);
  if (!deliverablesField) {
    throw new Error(
      `campaign 缺少 deliverables 配置，已阻断合同生成（campaign=${cid}，influencer=${
        creatorHandle || lookupKey
      }）。请先补充该 campaign 的交付结果后再重新触发。`
    );
  }

  const deliverablesText = await generateContractDeliverablesText({
    campaignId: cid,
    campaign: {
      campaignId: cid,
      brandName,
      productName,
      productLink,
      deliverables: deliverablesField,
      publishTimeRange: campaignInfo.publishTimeRange ?? null,
      platforms: parseCampaignPlatforms(campaignInfo.platform ?? campaignInfo.platforms),
    },
    execution: {
      stage: execution.stage,
      videoDraft: execution.video_draft ?? null,
      videoLink: execution.video_link ?? null,
      lastEvent: execution.lastEvent || {},
    },
    creator: {
      platform: parseCampaignPlatforms(influencer?.platform)[0] || influencer?.platform || null,
      handle: creatorHandle || lookupKey,
    },
    conversationHistory: history,
  });

  // 协商结果：优先用调用方传入，其次读执行表 last_event 上沉淀的约定
  const lastEvent = execution.lastEvent || {};
  const effectiveAdditionalTerms =
    additionalTerms != null
      ? normalizeAdditionalTerms(additionalTerms)
      : normalizeAdditionalTerms(lastEvent.contractAdditionalTerms);
  const effectiveSectionOverrides =
    sectionOverrides != null
      ? normalizeSectionOverrides(sectionOverrides)
      : normalizeSectionOverrides(lastEvent.contractSectionOverrides);
  const effectiveRevision = (() => {
    if (Number.isFinite(Number(revision)) && Number(revision) >= 1) {
      return Math.floor(Number(revision));
    }
    if (Number.isFinite(Number(lastEvent.contractRevision)) && Number(lastEvent.contractRevision) >= 1) {
      return Math.floor(Number(lastEvent.contractRevision));
    }
    return effectiveAdditionalTerms.length || Object.keys(effectiveSectionOverrides).length ? 2 : 1;
  })();

  const finalContractNo =
    contractNo ||
    buildContractNo({
      handle: creatorHandle || lookupKey,
      date: contractDateObj,
      revision: effectiveRevision,
    });
  const contractDate = formatContractDate(contractDateObj);

  const pdfBytes = await renderCollaborationContractPdf({
    contractNo: finalContractNo,
    contractDate,
    agency: {
      name: AGENCY_NAME,
      website: AGENCY_WEBSITE,
      signatory: AGENCY_SIGNATORY,
      title: AGENCY_TITLE,
    },
    creator: {
      displayName: influencer?.displayName || null,
      handle: creatorHandle || lookupKey,
      email: influencer?.influencerEmail || null,
      profileUrl: influencer?.profileUrl || null,
    },
    brandName,
    productLink,
    deliverablesText,
    feeAmount,
    currency,
    additionalTerms: effectiveAdditionalTerms,
    sectionOverrides: effectiveSectionOverrides,
  });

  // 保留历史版本：文件名加生成时间戳后缀
  const versionStamp = formatTimestampCompact(new Date());
  const storageKey = path.join(
    CONTRACTS_STORAGE_DIR,
    String(platformInfluencerId || creatorHandle || lookupKey),
    `${finalContractNo}-${versionStamp}.pdf`
  );
  const absPath = resolveContractAbsPath(storageKey);
  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  fs.writeFileSync(absPath, pdfBytes);

  // 邮件正文生成用的条款原文（与 PDF 同源）
  const clauses = buildContractClauses({
    deliverablesText,
    feeAmount,
    currency,
    sectionOverrides: effectiveSectionOverrides,
    additionalTerms: effectiveAdditionalTerms,
  });

  return {
    contractNo: finalContractNo,
    contractDate,
    revision: effectiveRevision,
    approvedAt: approvedSnapshot?.approvedAt || null,
    versionStamp,
    additionalTerms: effectiveAdditionalTerms,
    sectionOverrides: effectiveSectionOverrides,
    clauses,
    campaignId: cid,
    influencerId: platformInfluencerId,
    handle: creatorHandle || lookupKey,
    displayName: influencer?.displayName || null,
    email: influencer?.influencerEmail || null,
    feeAmount,
    currency,
    deliverablesText,
    storageKey,
    absPath,
  };
}
